PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  recovery_hash TEXT NOT NULL,
  recovery_salt TEXT NOT NULL,
  recovery_iterations INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  avatar_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deletion_requested_at INTEGER,
  deletion_due_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('custom_ai')),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS sync_entities (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  device_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, collection, entity_id)
);

CREATE TABLE IF NOT EXISTS sync_changes (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  device_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, device_id, operation_id)
);

CREATE INDEX IF NOT EXISTS sync_changes_user_cursor_idx ON sync_changes(user_id, change_id);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS users_deletion_due_idx ON users(deletion_due_at);
