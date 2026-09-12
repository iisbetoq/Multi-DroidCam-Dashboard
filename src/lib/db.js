import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DB_PATH || './data/nvr.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// wrapper to keep better-sqlite3-like API (prepare().get/.all/.run)
const origPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const stmt = origPrepare(sql);
  return {
    get: (...params) => stmt.get(...params),
    all: (...params) => stmt.all(...params),
    run: (...params) => {
      const r = stmt.run(...params);
      // normalize to better-sqlite3 shape
      return { lastInsertRowid: r.lastInsertRowid ?? r.lastInsertRowId, changes: r.changes };
    },
    stmt
  };
};

// migrations
db.exec(`
CREATE TABLE IF NOT EXISTS cameras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  recording_enabled INTEGER DEFAULT 0,
  recording_mode TEXT DEFAULT 'manual',
  recording_format TEXT DEFAULT 'mp4',
  segment_duration INTEGER DEFAULT 300,
  max_segment_size INTEGER DEFAULT 104857600,
  storage_id INTEGER DEFAULT 1,
  fps INTEGER DEFAULT 15,
  resolution TEXT DEFAULT '640x480',
  freeze_threshold INTEGER DEFAULT 60,
  reconnect_delay REAL DEFAULT 2.0,
  last_seen DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS storage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  start_time DATETIME,
  end_time DATETIME,
  duration INTEGER,
  size INTEGER,
  storage_id INTEGER DEFAULT 1,
  codec TEXT,
  fps INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(camera_id) REFERENCES cameras(id) ON DELETE CASCADE,
  FOREIGN KEY(storage_id) REFERENCES storage(id)
);
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id INTEGER NOT NULL,
  days TEXT DEFAULT '1,2,3,4,5,6,0', -- 0=Sun 1=Mon ... 6=Sat
  start_time TEXT NOT NULL, -- HH:MM
  end_time TEXT NOT NULL,   -- HH:MM
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(camera_id) REFERENCES cameras(id) ON DELETE CASCADE
);
`);

// seed storage
const hasStorage = db.prepare('SELECT COUNT(*) as c FROM storage').get().c;
if (hasStorage === 0) {
  db.prepare('INSERT INTO storage (name, path) VALUES (?,?)').run('Internal', './recordings');
  db.prepare('INSERT INTO storage (name, path) VALUES (?,?)').run('External SSD', '/media/ssd/nvr');
}

// seed settings
const defaults = {
  retention_days: '7',
  max_storage_percent: '80',
  cpu_threshold: '85',
  segment_duration: '300',
  max_segment_size_mb: '100'
};
for (const [k, v] of Object.entries(defaults)) {
  const exists = db.prepare('SELECT 1 FROM system_settings WHERE key=?').get(k);
  if (!exists) db.prepare('INSERT INTO system_settings (key,value) VALUES (?,?)').run(k, v);
}

export function getDb() { return db; }
export default db;
