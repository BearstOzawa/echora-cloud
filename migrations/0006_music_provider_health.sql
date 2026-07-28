PRAGMA foreign_keys = ON;

CREATE TABLE music_provider_health_daily (
  day TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('tx', 'wy', 'kw', 'kg', 'mg')),
  operation TEXT NOT NULL CHECK (operation IN ('search', 'chart', 'resolve')),
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  delegated_count INTEGER NOT NULL DEFAULT 0,
  latency_total_ms INTEGER NOT NULL DEFAULT 0,
  downgrade_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  last_error_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, provider_id, operation)
);

CREATE INDEX music_provider_health_updated_at_idx
ON music_provider_health_daily(updated_at);
