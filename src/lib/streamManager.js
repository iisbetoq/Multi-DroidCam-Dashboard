import crypto from 'crypto';
import db from './db.js';

class CameraStream {
  constructor(camera) {
    this.camera = camera;
    this.status = 'offline'; // online | offline | connecting
    this.lastSeen = null;
    this.failCount = 0;
    this.freezeCount = 0;
    this.lastHash = null;
    this.reconnectTimer = null;
    this.viewerClients = new Set(); // Set of {res, onClose}
    this.recorderPipes = new Set(); // Set of Writable (ffmpeg stdin)
    this.upstream = null;
    this.upstreamAbort = null;
    this.boundary = null;
    this.isConnecting = false;
    this.resolution = camera.resolution || '640x480';
    this.fpsEstimate = camera.fps || 15;
  }

  // start single upstream if needed (viewer or recorder demands it)
  ensureUpstream() {
    if (this.upstream || this.isConnecting) return;
    if (!this.camera.enabled) return;
    const needs = this.viewerClients.size > 0 || this.recorderPipes.size > 0 || this.camera.recording_enabled;
    if (!needs) return;
    this.connect();
  }

  maybeCloseUpstream() {
    const needs = this.viewerClients.size > 0 || this.recorderPipes.size > 0 || this.camera.recording_enabled;
    if (!needs && this.upstream) {
      this.disconnectUpstream();
    }
  }

  async connect() {
    if (this.isConnecting) return;
    this.isConnecting = true;
    this.status = 'connecting';
    this.broadcastStatus();
    const url = this.camera.url;
    // DroidCam Free: prefer /mjpegfeed (tested works), fallback /video
    let fetchUrl = url;
    if (!url.includes('/video') && !url.includes('/mjpegfeed')) {
      fetchUrl = url.replace(/\/$/, '') + '/mjpegfeed';
    }
    try {
      const controller = new AbortController();
      this.upstreamAbort = controller;
      const res = await fetch(fetchUrl, { signal: controller.signal, headers: { 'User-Agent': 'DroidCam-NVR/1.1' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const ctype = res.headers.get('content-type') || '';
      // extract boundary
      const m = ctype.match(/boundary=([^;]+)/i);
      this.boundary = m ? m[1].replace(/"/g, '').trim() : '--boundary';
      this.upstream = res.body;
      this.status = 'online';
      this.lastSeen = new Date().toISOString();
      this.failCount = 0;
      this.freezeCount = 0;
      db.prepare('UPDATE cameras SET last_seen=? WHERE id=?').run(this.lastSeen, this.camera.id);
      this.broadcastStatus();
      this.pumpMjpeg(res.body);
    } catch (e) {
      this.status = 'offline';
      this.failCount++;
      this.broadcastStatus();
      this.scheduleReconnect();
    } finally {
      this.isConnecting = false;
    }
  }

  pumpMjpeg(readable) {
    const reader = readable.getReader();
    let buffer = Buffer.alloc(0);
    let lastFrameHash = null;
    let freeze = 0;
    let frameCount = 0;

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) throw new Error('upstream done');
          // efficient append without extra copy when possible
          buffer = buffer.length ? Buffer.concat([buffer, Buffer.from(value)]) : Buffer.from(value);

          let start, end;
          while ((start = buffer.indexOf(Buffer.from([0xFF, 0xD8]))) !== -1 &&
                 (end = buffer.indexOf(Buffer.from([0xFF, 0xD9]), start)) !== -1) {
            const jpeg = buffer.subarray(start, end + 2);
            buffer = buffer.subarray(end + 2);
            frameCount++;

            // freeze detection: only every 5th frame (hemat CPU 80%)
            if (frameCount % 5 === 0) {
              const hash = crypto.createHash('md5').update(jpeg).digest('hex');
              if (hash === lastFrameHash) freeze++; else { freeze = 0; lastFrameHash = hash; }
              this.lastHash = hash;
              this.freezeCount = freeze;
              if (freeze >= (this.camera.freeze_threshold || 60)) {
                this.disconnectUpstream();
                this.scheduleReconnect(0);
                return;
              }
            }

            // broadcast with backpressure: skip if viewer lag
            this.broadcastMjpegFrame(jpeg);
            this.lastSeen = new Date().toISOString();
            this.status = 'online';
          }
          if (buffer.length > 2 * 1024 * 1024) buffer = buffer.subarray(buffer.length - 512*1024);
        }
      } catch (e) {
        this.disconnectUpstream();
        this.status = 'offline';
        this.broadcastStatus();
        this.scheduleReconnect();
      }
    };
    pump();
  }

  broadcastMjpegFrame(jpeg) {
    const header = `--droidcam\nContent-Type: image/jpeg\nContent-Length: ${jpeg.length}\n\n`;
    const footer = `\n`;
    const chunk = Buffer.concat([Buffer.from(header), jpeg, Buffer.from(footer)]);
    for (const c of this.viewerClients) {
      try {
        if (c.res.writableNeedDrain) continue;
        c.res.write(chunk);
      } catch {}
    }
    // feed recorder pipes (single-client fix: share same JPEG to ffmpeg stdin)
    for (const w of this.recorderPipes) {
      try {
        if (!w.destroyed && !w.writableNeedDrain) w.write(jpeg);
      } catch {}
    }
  }

  broadcastStatus() {
    // will be picked by SSE loop
  }

  addViewer(res) {
    this.viewerClients.add({ res });
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=droidcam',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Pragma': 'no-cache'
    });
    this.ensureUpstream();
    const onClose = () => {
      for (const c of this.viewerClients) if (c.res === res) this.viewerClients.delete(c);
      this.maybeCloseUpstream();
    };
    res.on('close', onClose);
    return onClose;
  }

  addRecorderPipe(writable) {
    this.recorderPipes.add(writable);
    this.ensureUpstream();
    const onClose = () => {
      this.recorderPipes.delete(writable);
      this.maybeCloseUpstream();
    };
    writable.on('close', onClose);
    writable.on('error', onClose);
    return onClose;
  }

  scheduleReconnect(delayMs) {
    if (this.reconnectTimer) return;
    const base = delayMs != null ? delayMs : (this.camera.reconnect_delay || 2) * 1000;
    // backoff if repeated fails
    const backoff = Math.min(base * Math.pow(1.2, Math.min(this.failCount, 5)), 10000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureUpstream();
      // if still needed but upstream not connected, try again
      if (!this.upstream && (this.viewerClients.size > 0 || this.camera.recording_enabled)) {
        this.connect();
      }
    }, backoff);
  }

  disconnectUpstream() {
    try { this.upstreamAbort?.abort(); } catch {}
    this.upstream = null;
    this.upstreamAbort = null;
    this.isConnecting = false;
  }

  updateCamera(newCam) {
    this.camera = newCam;
    if (!newCam.enabled) {
      this.status = 'offline';
      this.disconnectUpstream();
      // close viewers?
    } else {
      this.ensureUpstream();
    }
  }

  destroy() {
    clearTimeout(this.reconnectTimer);
    this.disconnectUpstream();
    for (const c of this.viewerClients) try { c.res.end(); } catch {}
    this.viewerClients.clear();
  }

  getStatus() {
    return {
      id: this.camera.id,
      name: this.camera.name,
      url: this.camera.url,
      enabled: !!this.camera.enabled,
      recording_enabled: !!this.camera.recording_enabled,
      status: this.status,
      last_seen: this.lastSeen,
      viewers: this.viewerClients.size,
      failCount: this.failCount,
      freezeCount: this.freezeCount,
      resolution: this.resolution,
      fps: this.fpsEstimate
    };
  }
}

class StreamManager {
  constructor() {
    this.cameras = new Map(); // id -> CameraStream
    this.initFromDb();
    // poll db for changes every 3s + on-demand via refresh()
    setInterval(() => this.syncFromDb(), 5000);
  }

  initFromDb() {
    const rows = db.prepare('SELECT * FROM cameras').all();
    for (const r of rows) this.cameras.set(r.id, new CameraStream(r));
  }

  syncFromDb() {
    const rows = db.prepare('SELECT * FROM cameras').all();
    const ids = new Set(rows.map(r => r.id));
    for (const r of rows) {
      const existing = this.cameras.get(r.id);
      if (!existing) this.cameras.set(r.id, new CameraStream(r));
      else existing.updateCamera(r);
    }
    for (const [id, cs] of this.cameras) if (!ids.has(id)) { cs.destroy(); this.cameras.delete(id); }
  }

  refresh() { this.syncFromDb(); }

  get(id) { return this.cameras.get(Number(id)); }
  all() { return [...this.cameras.values()]; }
  statusAll() { return this.all().map(c => c.getStatus()); }
}

const streamManager = new StreamManager();
export default streamManager;
