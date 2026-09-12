import express from 'express';
import fs from 'fs';
import { execSync } from 'child_process';
import db from '../lib/db.js';
import streamManager from '../lib/streamManager.js';
import recorder from '../lib/recorder.js';
import { getStorageStats, runRetention } from '../lib/storageManager.js';
import { getSystemStatus } from '../lib/systemMonitor.js';

const router = express.Router();

// --- cameras ---
router.get('/cameras', (req, res) => {
  const cams = db.prepare('SELECT * FROM cameras ORDER BY id').all();
  const statuses = streamManager.statusAll();
  const merged = cams.map(c => {
    const s = statuses.find(x => x.id === c.id);
    return { ...c, status: s?.status || 'offline', last_seen: s?.last_seen || c.last_seen, viewers: s?.viewers || 0 };
  });
  res.json(merged);
});

router.post('/cameras', (req, res) => {
  const { name, url, enabled=1, recording_enabled=0, recording_mode='manual', recording_format='mp4', segment_duration=300, max_segment_size=104857600, storage_id=1 } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const r = db.prepare(`INSERT INTO cameras (name,url,enabled,recording_enabled,recording_mode,recording_format,segment_duration,max_segment_size,storage_id) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(name, url, enabled?1:0, recording_enabled?1:0, recording_mode, recording_format, segment_duration, max_segment_size, storage_id);
  streamManager.refresh();
  res.json({ id: r.lastInsertRowid });
});

router.put('/cameras/:id', (req, res) => {
  const id = req.params.id;
  const cur = db.prepare('SELECT * FROM cameras WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const fields = ['name','url','enabled','recording_enabled','recording_mode','recording_format','segment_duration','max_segment_size','storage_id','fps','resolution'];
  const data = { ...cur, ...req.body };
  // normalize booleans
  if (req.body.enabled !== undefined) data.enabled = req.body.enabled?1:0;
  if (req.body.recording_enabled !== undefined) data.recording_enabled = req.body.recording_enabled?1:0;
  db.prepare(`UPDATE cameras SET name=?,url=?,enabled=?,recording_enabled=?,recording_mode=?,recording_format=?,segment_duration=?,max_segment_size=?,storage_id=?,fps=?,resolution=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(data.name, data.url, data.enabled, data.recording_enabled, data.recording_mode, data.recording_format, data.segment_duration, data.max_segment_size, data.storage_id, data.fps||15, data.resolution||'640x480', id);
  streamManager.refresh();
  res.json({ ok: true });
});

router.delete('/cameras/:id', (req, res) => {
  db.prepare('DELETE FROM cameras WHERE id=?').run(req.params.id);
  streamManager.refresh();
  recorder.stop(Number(req.params.id));
  res.json({ ok: true });
});

router.get('/cameras/:id/status', (req, res) => {
  const s = streamManager.get(req.params.id)?.getStatus();
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});

router.post('/cameras/:id/test', async (req, res) => {
  const cam = db.prepare('SELECT * FROM cameras WHERE id=?').get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'not found' });
  let url = cam.url;
  if (!url.includes('/video') && !url.includes('/mjpegfeed')) url = url.replace(/\/$/,'')+'/video';
  try {
    const controller = new AbortController();
    setTimeout(()=>controller.abort(), 5000);
    const r = await fetch(url, { signal: controller.signal });
    // try to read a chunk
    const ok = r.ok;
    res.json({ ok, status: r.status, contentType: r.headers.get('content-type') });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/cameras/:id/record/start', (req, res) => {
  const id = req.params.id;
  db.prepare('UPDATE cameras SET recording_enabled=1 WHERE id=?').run(id);
  streamManager.refresh();
  res.json({ ok: true });
});
router.post('/cameras/:id/record/stop', (req, res) => {
  const id = req.params.id;
  db.prepare('UPDATE cameras SET recording_enabled=0 WHERE id=?').run(id);
  streamManager.refresh();
  recorder.stop(Number(id));
  res.json({ ok: true });
});

// --- schedules (dormant, ready for future use) ---
router.get('/cameras/:id/schedules', (req, res) => {
  const rows = db.prepare('SELECT * FROM schedules WHERE camera_id=? ORDER BY start_time').all(req.params.id);
  res.json(rows);
});
router.post('/cameras/:id/schedules', (req, res) => {
  const { days='1,2,3,4,5,6,0', start_time, end_time, enabled=1 } = req.body;
  if (!start_time || !end_time) return res.status(400).json({ error: 'start_time and end_time HH:MM required' });
  const r = db.prepare('INSERT INTO schedules (camera_id,days,start_time,end_time,enabled) VALUES (?,?,?,?,?)').run(req.params.id, days, start_time, end_time, enabled?1:0);
  res.json({ id: r.lastInsertRowid });
});
router.put('/cameras/:id/schedules/:sid', (req, res) => {
  const cur = db.prepare('SELECT * FROM schedules WHERE id=? AND camera_id=?').get(req.params.sid, req.params.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const { days=cur.days, start_time=cur.start_time, end_time=cur.end_time, enabled=cur.enabled } = req.body;
  db.prepare('UPDATE schedules SET days=?,start_time=?,end_time=?,enabled=? WHERE id=?').run(days, start_time, end_time, enabled?1:0, req.params.sid);
  res.json({ ok: true });
});
router.delete('/cameras/:id/schedules/:sid', (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id=? AND camera_id=?').run(req.params.sid, req.params.id);
  res.json({ ok: true });
});

// proxy mjpeg viewer - single upstream
router.get('/cameras/:id/stream', (req, res) => {
  const cs = streamManager.get(req.params.id);
  if (!cs) return res.status(404).end('not found');
  cs.addViewer(res);
});

// --- recordings ---
router.get('/recordings', (req, res) => {
  const { camera_id, date, storage_id, page=1, limit=20 } = req.query;
  let where = []; let params = [];
  if (camera_id) { where.push('camera_id=?'); params.push(camera_id); }
  if (storage_id) { where.push('storage_id=?'); params.push(storage_id); }
  if (date) { // date YYYY-MM-DD
    where.push('date(start_time)=date(?)'); params.push(date);
  }
  const w = where.length ? 'WHERE '+where.join(' AND ') : '';
  const count = db.prepare(`SELECT COUNT(*) as c FROM recordings ${w}`).get(...params).c;
  const offset = (parseInt(page)-1)*parseInt(limit);
  const rows = db.prepare(`SELECT * FROM recordings ${w} ORDER BY start_time DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), offset);
  res.json({ total: count, page: parseInt(page), limit: parseInt(limit), data: rows });
});

router.get('/recordings/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM recordings WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

router.delete('/recordings/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM recordings WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  try { fs.unlinkSync(r.path); } catch {}
  db.prepare('DELETE FROM recordings WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/recordings/:id/stream', (req, res) => {
  const r = db.prepare('SELECT * FROM recordings WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).end('not found');
  if (!fs.existsSync(r.path)) return res.status(404).end('file missing');
  const stat = fs.statSync(r.path);
  const ext = r.path.endsWith('.avi') ? 'avi' : 'mp4';
  res.writeHead(200, { 'Content-Type': ext==='avi'?'video/x-msvideo':'video/mp4', 'Content-Length': stat.size, 'Accept-Ranges':'bytes' });
  fs.createReadStream(r.path).pipe(res);
});

// --- storage ---
router.get('/storage', (req, res) => {
  res.json(getStorageStats());
});
router.post('/storage', (req, res) => {
  const { name, path, enabled=1 } = req.body;
  if (!name || !path) return res.status(400).json({ error: 'name path required' });
  try {
    db.prepare('INSERT INTO storage (name,path,enabled) VALUES (?,?,?)').run(name, path, enabled?1:0);
    res.json({ ok: true });
  } catch(e){ res.status(400).json({ error: e.message }); }
});
router.put('/storage/:id', (req,res)=>{
  const s=db.prepare('SELECT * FROM storage WHERE id=?').get(req.params.id);
  if(!s) return res.status(404).json({error:'not found'});
  db.prepare('UPDATE storage SET name=?,path=?,enabled=? WHERE id=?').run(req.body.name||s.name, req.body.path||s.path, req.body.enabled!=null?(req.body.enabled?1:0):s.enabled, req.params.id);
  res.json({ok:true});
});
router.delete('/storage/:id', (req,res)=>{
  db.prepare('DELETE FROM storage WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

router.post('/storage/retention/run', (req,res)=>{
  runRetention();
  res.json({ok:true});
});

router.post('/storage/:id/mount', (req,res)=>{
  const s=db.prepare('SELECT * FROM storage WHERE id=?').get(req.params.id);
  if(!s) return res.status(404).json({error:'not found'});
  try {
    try { fs.mkdirSync(s.path,{recursive:true}); } catch {}
    try {
      const df=execSync(`df "${s.path}" 2>&1 | tail -n 1`).toString();
      if (df.includes(s.path) && !df.includes('df:')) return res.json({ok:true, msg:'already mounted'});
    } catch {}
    try {
      const m=execSync(`sudo -n mount -t exfat -o uid=1000,gid=1000,umask=000 /dev/sda2 "${s.path}" 2>&1 || sudo -n mount /dev/sda2 "${s.path}" 2>&1 || echo "need sudo password"`).toString();
      if(m.includes('need sudo')) return res.json({ok:false, error:m, hint:`Jalankan di STB: sudo mkdir -p ${s.path} && sudo mount -t exfat -o uid=1000,gid=1000,umask=000 /dev/sda2 ${s.path}`});
      return res.json({ok:true, out:m});
    } catch(e){ return res.json({ok:false, error:e.message, hint:`Jalankan di STB: sudo mount -t exfat -o uid=1000,gid=1000,umask=000 /dev/sda2 ${s.path}`}); }
  } catch(e){ res.json({ok:false, error:e.message}); }
});
router.post('/storage/:id/unmount', (req,res)=>{
  const s=db.prepare('SELECT * FROM storage WHERE id=?').get(req.params.id);
  if(!s) return res.status(404).json({error:'not found'});
  try {
    const out=execSync(`sudo -n umount "${s.path}" 2>&1 || echo "need sudo: sudo umount ${s.path}"`).toString();
    if(out.includes('need sudo')) return res.json({ok:false, error:out, hint:`sudo umount ${s.path}`});
    res.json({ok:true, out});
  } catch(e){ res.json({ok:false, error:e.message}); }
});

// --- system ---
router.get('/system/status', (req,res)=>{
  res.json(getSystemStatus(streamManager, recorder));
});

router.get('/system/settings', (req,res)=>{
  const rows=db.prepare('SELECT * FROM system_settings').all();
  const o={}; rows.forEach(r=>o[r.key]=r.value);
  res.json(o);
});
router.put('/system/settings', (req,res)=>{
  for(const [k,v] of Object.entries(req.body)){
    db.prepare('INSERT INTO system_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP').run(k, String(v));
  }
  res.json({ok:true});
});

export default router;
