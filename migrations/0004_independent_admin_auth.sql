-- Development reset: user and administrator identities intentionally become
-- separate domains without preserving the pre-release account data.
DROP TABLE IF EXISTS admin_audit_log;
DROP TABLE IF EXISTS user_credentials;
DROP TABLE IF EXISTS sync_changes;
DROP TABLE IF EXISTS sync_entities;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS admin_accounts;
DROP TABLE IF EXISTS auth_risk;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  recovery_hash TEXT NOT NULL,
  recovery_salt TEXT NOT NULL,
  recovery_iterations INTEGER NOT NULL,
  avatar_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deletion_requested_at INTEGER,
  deletion_due_at INTEGER,
  disabled_at INTEGER
);

CREATE INDEX users_deletion_due_idx ON users(deletion_due_at);
CREATE INDEX users_disabled_at_idx ON users(disabled_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (user_id, device_id)
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE user_credentials (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('custom_ai')),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE sync_entities (
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

CREATE TABLE sync_changes (
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

CREATE INDEX sync_changes_user_cursor_idx ON sync_changes(user_id, change_id);

CREATE TABLE admin_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX admin_sessions_admin_id_idx ON admin_sessions(admin_id);
CREATE INDEX admin_sessions_expires_at_idx ON admin_sessions(expires_at);

CREATE TABLE admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_admin_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX admin_audit_log_created_at_idx ON admin_audit_log(created_at DESC);

CREATE TABLE auth_risk (
  risk_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  challenge_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX auth_risk_updated_at_idx ON auth_risk(updated_at);
