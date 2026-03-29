/**
 * SQLite database schema and access layer.
 */

const Database = require('better-sqlite3');
const config = require('../config');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);

// Performance settings
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -64000'); // 64MB cache

function initialize() {
  db.exec(`
    -- API Keys
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      project TEXT DEFAULT '',
      scopes TEXT DEFAULT 'write',
      rate_limit INTEGER DEFAULT 120,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT,
      total_events INTEGER DEFAULT 0
    );

    -- Sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      api_key_id INTEGER REFERENCES api_keys(id),
      session_name TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      participant_id TEXT DEFAULT '',
      study_id INTEGER REFERENCES studies(id),
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      event_count INTEGER DEFAULT 0,
      screenshot_count INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Events (main time-series data)
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      url TEXT DEFAULT '',
      tab_id INTEGER,
      x REAL,
      y REAL,
      page_x REAL,
      page_y REAL,
      scroll_x REAL,
      scroll_y REAL,
      viewport_width REAL,
      viewport_height REAL,
      extra TEXT DEFAULT '{}'
    );

    -- Screenshots
    CREATE TABLE IF NOT EXISTS screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      timestamp INTEGER NOT NULL,
      url TEXT DEFAULT '',
      tab_id INTEGER,
      trigger_type TEXT DEFAULT 'periodic',
      width INTEGER,
      height INTEGER,
      file_path TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Studies (experiment grouping)
    CREATE TABLE IF NOT EXISTS studies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      target_urls TEXT DEFAULT '[]',
      participant_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      config TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Participants
    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      study_id INTEGER NOT NULL REFERENCES studies(id),
      participant_id TEXT NOT NULL,
      group_name TEXT DEFAULT 'default',
      metadata TEXT DEFAULT '{}',
      consent_given INTEGER DEFAULT 0,
      consent_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(study_id, participant_id)
    );

    -- Webhooks
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      events TEXT DEFAULT '["session_end"]',
      secret TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      api_key_id INTEGER REFERENCES api_keys(id),
      created_at TEXT DEFAULT (datetime('now')),
      last_triggered_at TEXT,
      failure_count INTEGER DEFAULT 0
    );

    -- Indexes for query performance
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_url ON events(url);
    CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, type);
    CREATE INDEX IF NOT EXISTS idx_screenshots_session ON screenshots(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_api_key ON sessions(api_key_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_study ON sessions(study_id);
    CREATE INDEX IF NOT EXISTS idx_participants_study ON participants(study_id);

    -- Tasks (research task/scenario definitions within a study)
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      study_id INTEGER NOT NULL REFERENCES studies(id),
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      instructions TEXT DEFAULT '',
      target_url TEXT DEFAULT '',
      success_criteria TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_study ON tasks(study_id);

    -- Task Instances (per-participant task attempts)
    CREATE TABLE IF NOT EXISTS task_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      session_id TEXT NOT NULL REFERENCES sessions(id),
      participant_id TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      start_time INTEGER,
      end_time INTEGER,
      duration INTEGER,
      success INTEGER,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_instances_task ON task_instances(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_instances_session ON task_instances(session_id);

    -- Session Tags & Annotations
    CREATE TABLE IF NOT EXISTS session_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      tag TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_session_tags_session ON session_tags(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);

    CREATE TABLE IF NOT EXISTS session_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      timestamp INTEGER,
      text TEXT NOT NULL,
      author TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_session_annotations_session ON session_annotations(session_id);

    -- Feedback & Bug Reports
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'extension',
      type TEXT NOT NULL DEFAULT 'bug',
      category TEXT DEFAULT 'uncategorized',
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'new',
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      steps_to_reproduce TEXT DEFAULT '',
      expected_behavior TEXT DEFAULT '',
      actual_behavior TEXT DEFAULT '',
      url TEXT DEFAULT '',
      browser_info TEXT DEFAULT '{}',
      session_id TEXT DEFAULT '',
      participant_id TEXT DEFAULT '',
      screenshot_data TEXT DEFAULT '',
      assigned_to TEXT DEFAULT '',
      resolution_notes TEXT DEFAULT '',
      api_key_id INTEGER REFERENCES api_keys(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
    CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback(type);
    CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category);
    CREATE INDEX IF NOT EXISTS idx_feedback_priority ON feedback(priority);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
  `);

  console.log('Database initialized');
}

// Initialize immediately so tables exist before prepared statements are created
initialize();

module.exports = { db, initialize };
