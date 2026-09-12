import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import api from './routes/api.js';
import db from './lib/db.js';
import streamManager from './lib/streamManager.js';
import recorder from './lib/recorder.js';
import { getSystemStatus } from './lib/systemMonitor.js';
import { getStorageStats } from './lib/storageManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// static frontend
app.use(express.static(path.join(__dirname, '../public')));
app.use('/recordings', express.static(path.join(__dirname, '../recordings'), { fallthrough: true }));

app.use('/api', api);

// SSE for realtime status
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  const send = () => {
    const data = {
      cameras: streamManager.statusAll(),
      system: getSystemStatus(streamManager, recorder),
      storage: getStorageStats(),
      recording: recorder.getStatus()
    };
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send();
  const interval = setInterval(send, 2000);
  req.on('close', () => clearInterval(interval));
});

// fallback to index.html for SPA
app.get('*', (req, res) => {
  const p = path.join(__dirname, '../public/index.html');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send('Not found');
});

const server = app.listen(PORT, HOST, () => {
  console.log(`DroidCam NVR running at http://${HOST}:${PORT}`);
  console.log(`DB: ${process.env.DB_PATH || './data/nvr.db'}`);
});

// graceful shutdown: keep recording-safe close
process.on('SIGTERM', () => {
  console.log('SIGTERM - closing...');
  recorder.stopAll();
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  recorder.stopAll();
  server.close(() => process.exit(0));
});
