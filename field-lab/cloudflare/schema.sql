PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS field_lab_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_digest TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  plan_expires_at TEXT,
  sites_used INTEGER NOT NULL DEFAULT 0 CHECK (sites_used >= 0),
  questions_used INTEGER NOT NULL DEFAULT 0 CHECK (questions_used >= 0),
  usage_window_started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS field_lab_usage_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES field_lab_users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('site', 'question')),
  request_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, action, request_id),
  UNIQUE (nonce)
);

CREATE INDEX IF NOT EXISTS idx_field_lab_users_email ON field_lab_users(email);
CREATE INDEX IF NOT EXISTS idx_field_lab_usage_receipts_user ON field_lab_usage_receipts(user_id);
