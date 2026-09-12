import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import db from './db.js';

export function getStorageStats() {
  const storages = db.prepare('SELECT * FROM storage').all();
  return storages.map(s => {
    try {
      const stat = fs.statSync(s.path);
      // use statfs via df
      let total = 0, free = 0, used = 0;
      try {
        const out = execSync(`df -B1 "${s.path}" 2>/dev/null | tail -n 1`).toString().trim();
        const parts = out.split(/\s+/);
        // parts: filesystem, 1B-blocks, Used, Available, Use%, Mounted
        if (parts.length >= 4) {
          total = parseInt(parts[1]) || 0;
          used = parseInt(parts[2]) || 0;
          free = parseInt(parts[3]) || 0;
        }
      } catch {
        // fallback: if path not exists, try parent
        total = 0; used = 0; free = 0;
      }
      const exists = fs.existsSync(s.path);
      return {
        id: s.id,
        name: s.name,
        path: s.path,
        enabled: !!s.enabled,
        exists,
        total,
        used,
        free,
        percent: total ? Math.round((used / total) * 100) : 0
      };
    } catch {
      return { id: s.id, name: s.name, path: s.path, enabled: !!s.enabled, exists: false, total: 0, used: 0, free: 0, percent: 0 };
    }
  });
}

export function ensureStoragePaths() {
  const storages = db.prepare('SELECT * FROM storage').all();
  for (const s of storages) {
    try { fs.mkdirSync(s.path, { recursive: true }); } catch {}
  }
}

// retention: delete oldest recordings if age > retention_days or storage > max_percent
export function runRetention() {
  const retentionDays = parseInt(db.prepare("SELECT value FROM system_settings WHERE key='retention_days'").get()?.value || '7');
  const maxPercent = parseInt(db.prepare("SELECT value FROM system_settings WHERE key='max_storage_percent'").get()?.value || '80');

  // 1) age-based
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
  const old = db.prepare('SELECT * FROM recordings WHERE start_time < ? ORDER BY start_time ASC').all(cutoff);
  for (const r of old) {
    if (isFileActive(r.path)) continue;
    try { fs.unlinkSync(r.path); } catch {}
    db.prepare('DELETE FROM recordings WHERE id=?').run(r.id);
    console.log(`[retention] deleted old ${r.path}`);
  }

  // 2) storage-percent based
  const stats = getStorageStats();
  for (const s of stats) {
    if (s.percent <= maxPercent) continue;
    // delete oldest until below threshold
    const recs = db.prepare('SELECT * FROM recordings WHERE storage_id=? ORDER BY start_time ASC').all(s.id);
    for (const r of recs) {
      if (s.percent <= maxPercent) break;
      if (isFileActive(r.path)) continue;
      try { fs.unlinkSync(r.path); } catch {}
      db.prepare('DELETE FROM recordings WHERE id=?').run(r.id);
      console.log(`[retention] deleted due to storage ${r.path}`);
      // re-check stat (approx)
      const current = getStorageStats().find(x => x.id === s.id);
      if (current) s.percent = current.percent;
    }
  }
}

function isFileActive(p) {
  // check if any recorder process has this file open (simple: file mtime <2s ago => active)
  try {
    const st = fs.statSync(p);
    return (Date.now() - st.mtimeMs) < 3000;
  } catch { return false; }
}

// run every 60s
setInterval(runRetention, 60 * 1000);
