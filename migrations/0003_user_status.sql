ALTER TABLE users ADD COLUMN disabled_at INTEGER;

CREATE INDEX IF NOT EXISTS users_disabled_at_idx ON users(disabled_at);
