import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import db from './db.js';

class Recorder {
  constructor() {
    this.processes = new Map();
    this.checkInterval = setInterval(() => this.sync(), 3000);
    fs.mkdirSync('./recordings', { recursive: true });
    this.hwEncoder = null;
    this.detectHw();
  }
  async detectHw() { this.hwEncoder = null; }
  isInSchedule(camera) {
    if (camera.recording_mode !== 'schedule') return true;
    const schedules = db.prepare('SELECT * FROM schedules WHERE camera_id=? AND enabled=1').all(camera.id);
    if (!schedules.length) return false;
    const now = new Date(); const day = now.getDay(); const curMin = now.getHours()*60+now.getMinutes();
    for (const s of schedules) {
      const days = s.days.split(',').map(Number);
      if (!days.includes(day)) continue;
      const [sh, sm] = s.start_time.split(':').map(Number);
      const [eh, em] = s.end_time.split(':').map(Number);
      const startMin = sh*60+sm, endMin = eh*60+em;
      if (startMin <= endMin) { if (curMin>=startMin && curMin<endMin) return true; }
      else { if (curMin>=startMin || curMin<endMin) return true; }
    }
    return false;
  }
  sync() {
    const cams = db.prepare('SELECT * FROM cameras').all();
    for (const cam of cams) {
      let should = !!cam.enabled && !!cam.recording_enabled;
      if (should && cam.recording_mode==='schedule' && !this.isInSchedule(cam)) should=false;
      const running=this.processes.has(cam.id);
      if (should && !running) this.start(cam);
      if (!should && running) this.stop(cam.id);
      if (should && running) {
        const p=this.processes.get(cam.id);
        if (p.proc.exitCode!==null) { this.processes.delete(cam.id); this.start(cam); }
      }
    }
  }
  buildOutputPath(camera) {
    const now=new Date();
    const dir=path.join('./recordings',`cam${String(camera.id).padStart(2,'0')}`,String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
    fs.mkdirSync(dir,{recursive:true});
    const stor=db.prepare('SELECT * FROM storage WHERE id=?').get(camera.storage_id);
    let baseDir=dir;
    if (stor && stor.path!=='./recordings' && stor.enabled) {
      baseDir=path.join(stor.path,`cam${String(camera.id).padStart(2,'0')}`,String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
      fs.mkdirSync(baseDir,{recursive:true});
    }
    return {dir:baseDir};
  }
  start(camera) {
    if (this.processes.has(camera.id)) return;
    const isAvi=camera.recording_format==='avi';
    const duration=camera.segment_duration||300;
    const maxSize=camera.max_segment_size||104857600;
    const {dir}=this.buildOutputPath(camera);
    const ext=isAvi?'avi':'mp4';
    const segmentPattern=path.join(dir,`%H-%M-%S.${ext}`);
    this.startPipe(camera, segmentPattern, dir, maxSize, isAvi, duration);
  }
  async startPipe(camera, segmentPattern, dir, maxSize, isAvi, duration) {
    const { default: streamManager } = await import('./streamManager.js');
    const cs = streamManager.get(camera.id);
    let args;
    if (isAvi) {
      args=['-hide_banner','-loglevel','warning','-f','mjpeg','-use_wallclock_as_timestamps','1','-i','pipe:0','-c:v','copy','-f','segment','-segment_time',String(duration),'-segment_format','avi','-reset_timestamps','1','-strftime','1',segmentPattern];
    } else {
      args=['-hide_banner','-loglevel','warning','-f','mjpeg','-i','pipe:0','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-r',String(camera.fps||15),'-an','-f','segment','-segment_time',String(duration),'-segment_format','mp4','-reset_timestamps','1','-strftime','1','-movflags','+faststart',segmentPattern];
    }
    const proc=spawn('ffmpeg', args, {stdio:['pipe','pipe','pipe']});
    let stderr='';
    proc.stderr.on('data', d=>{ stderr+=d.toString().slice(0,4000); });
    proc.on('error', err=>{ console.error(`[recorder cam${camera.id}] spawn error`,err.message); this.processes.delete(camera.id); });
    proc.on('close', code=>{
      if (stderr) console.log(`[recorder cam${camera.id}] ffmpeg close ${code} ${stderr.slice(0,500)}`);
      const stillShould=db.prepare('SELECT recording_enabled,enabled FROM cameras WHERE id=?').get(camera.id);
      // cleanup pipe
      if (cs) cs.recorderPipes.delete(proc.stdin);
      this.processes.delete(camera.id);
      if (stillShould?.recording_enabled && stillShould?.enabled) {
        setTimeout(()=>{ const fresh=db.prepare('SELECT * FROM cameras WHERE id=?').get(camera.id); if(fresh) this.start(fresh); },3000);
      }
    });
    // register pipe to streamManager (single upstream share)
    if (cs) cs.addRecorderPipe(proc.stdin);
    else proc.stdin.on('error',()=>{});
    const entry={proc,camera,startTime:new Date(),currentPattern:segmentPattern,maxSize,dir,monitor:null};
    this.processes.set(camera.id, entry);
    entry.monitor=setInterval(()=>this.checkSize(camera.id),2000);
    console.log(`[recorder] cam${camera.id} pipe started pid=${proc.pid} ${isAvi?'avi/copy':'mp4/h264'} pattern=${segmentPattern}`);
  }
  checkSize(cameraId) {
    const e=this.processes.get(cameraId); if(!e) return;
    try {
      const files=fs.readdirSync(e.dir).filter(f=>f.endsWith('.mp4')||f.endsWith('.avi')).map(f=>path.join(e.dir,f));
      if(!files.length) return;
      let newest=files[0], newestTime=0;
      for(const f of files){ const st=fs.statSync(f); if(st.mtimeMs>newestTime){ newestTime=st.mtimeMs; newest=f; } }
      const stat=fs.statSync(newest);
      if(stat.size>=e.maxSize){ console.log(`[recorder] cam${cameraId} size ${stat.size} >= ${e.maxSize} -> rotating`); this.restart(cameraId); }
      this.harvest(e.camera, e.dir);
    } catch {}
  }
  harvest(camera, dir) {
    try {
      const files=fs.readdirSync(dir);
      for(const f of files){
        const full=path.join(dir,f);
        const exists=db.prepare('SELECT 1 FROM recordings WHERE path=?').get(full);
        if(exists) continue;
        const st=fs.statSync(full);
        if(st.size<1024) continue;
        const m=f.match(/(\d{2})-(\d{2})-(\d{2})\.(mp4|avi)/);
        let startTime=null;
        if(m){
          const dirParts=dir.split(path.sep);
          const dd=dirParts[dirParts.length-1], mm=dirParts[dirParts.length-2], yyyy=dirParts[dirParts.length-3];
          startTime=new Date(`${yyyy}-${mm}-${dd}T${m[1]}:${m[2]}:${m[3]}`);
          if(isNaN(startTime)) startTime=new Date(st.mtime);
        } else startTime=new Date(st.mtime);
        db.prepare(`INSERT INTO recordings (camera_id,filename,path,start_time,end_time,duration,size,storage_id,codec,fps) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(camera.id,f,full,startTime.toISOString(),new Date(st.mtime).toISOString(),null,st.size,camera.storage_id,camera.recording_format==='avi'?'mjpeg':'h264',camera.fps);
      }
      const rows=db.prepare('SELECT * FROM recordings WHERE camera_id=?').all(camera.id);
      for(const r of rows){ try{ const st=fs.statSync(r.path); if(st.size!==r.size) db.prepare('UPDATE recordings SET size=? WHERE id=?').run(st.size,r.id); }catch{} }
    } catch {}
  }
  restart(cameraId){ const e=this.processes.get(cameraId); if(!e) return; clearInterval(e.monitor); try{ e.proc.stdin.end(); e.proc.kill('SIGTERM'); }catch{} this.processes.delete(cameraId); setTimeout(()=>{ const fresh=db.prepare('SELECT * FROM cameras WHERE id=?').get(cameraId); if(fresh&&fresh.recording_enabled&&fresh.enabled) this.start(fresh); },1000); }
  stop(cameraId){ const e=this.processes.get(cameraId); if(!e) return; clearInterval(e.monitor); try{ e.proc.stdin.end(); e.proc.kill('SIGTERM'); setTimeout(()=>{ try{ e.proc.kill('SIGKILL'); }catch{} },3000); }catch{} // also remove from pipe set
    import('./streamManager.js').then(m=>{ const cs=m.default.get(cameraId); if(cs) cs.recorderPipes.delete(e.proc.stdin); }).catch(()=>{});
    this.processes.delete(cameraId); console.log(`[recorder] cam${cameraId} stopped`); }
  stopAll(){ for(const id of [...this.processes.keys()]) this.stop(id); clearInterval(this.checkInterval); }
  getStatus(){ return [...this.processes.entries()].map(([id,e])=>({camera_id:id,pid:e.proc.pid,running:e.proc.exitCode===null,pattern:e.currentPattern})); }
}
const recorder=new Recorder();
export default recorder;
