import fs from 'fs';
import { execSync } from 'child_process';
import db from './db.js';
import { getStorageStats } from './storageManager.js';

let prevCpu = null;

export function getCpuUsage() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = stat.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    if (!prevCpu) { prevCpu = { idle, total }; return 0; }
    const diffIdle = idle - prevCpu.idle;
    const diffTotal = total - prevCpu.total;
    prevCpu = { idle, total };
    if (diffTotal === 0) return 0;
    return Math.round((1 - diffIdle / diffTotal) * 100);
  } catch { return 0; }
}

export function getMem() {
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = parseInt(mem.match(/MemTotal:\s+(\d+)/)[1]) * 1024;
    const avail = parseInt(mem.match(/MemAvailable:\s+(\d+)/)[1]) * 1024;
    const used = total - avail;
    return { total, used, free: avail };
  } catch { return { total: 0, used: 0, free: 0 }; }
}

export function getSystemStatus(streamManager, recorder) {
  const cpu = getCpuUsage();
  const mem = getMem();
  // gabungan semua storage enabled (Internal + External Storage)
  const storages = (() => {
    try {
      const stats = getStorageStats();
      let total=0, used=0, free=0;
      for(const s of stats) if(s.enabled && s.exists){ total+=s.total; used+=s.used; free+=s.free; }
      if(total) return { total, used, free };
    } catch {}
    try {
      const out = execSync('df -B1 ./recordings 2>/dev/null | tail -n 1').toString().trim().split(/\s+/);
      return { total: parseInt(out[1])||0, used: parseInt(out[2])||0, free: parseInt(out[3])||0 };
    } catch { return { total: 0, used: 0, free: 0 }; }
  })();
  const cams = db.prepare('SELECT COUNT(*) as c FROM cameras').get().c;
  const online = streamManager.statusAll().filter(s => s.status === 'online').length;
  const recording = recorder.getStatus().length;
  const ffmpeg = recording;
  // estimasi sisa durasi rekam: free / (bitrate per cam * jumlah cam aktif/total)
  const bitrateMbps = 0.8; // 640x480 15fps H264 ~0.8 Mbps
  const activeCams = recording || cams || 1;
  const bytesPerSec = (bitrateMbps * 1000000 / 8) * activeCams;
  const estSeconds = bytesPerSec ? Math.floor(storages.free / bytesPerSec) : 0;
  const est = { seconds: estSeconds, hours: Math.floor(estSeconds/3600), days: Math.floor(estSeconds/86400) };
  return {
    cpu, ram: mem, storage: { ...storages, est },
    cameras: { total: cams, online },
    recording: { active: recording },
    ffmpeg: { processes: ffmpeg },
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  };
}
