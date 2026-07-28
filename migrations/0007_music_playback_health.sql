PRAGMA foreign_keys = ON;

CREATE TABLE music_provider_health_daily_next (
  day TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('tx', 'wy', 'kw', 'kg', 'mg')),
  operation TEXT NOT NULL CHECK (operation IN ('search', 'chart', 'resolve', 'playback')),
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

INSERT INTO music_provider_health_daily_next (
  day, provider_id, operation, request_count, success_count, error_count,
  delegated_count, latency_total_ms, downgrade_count,
  last_error_code, last_error_message, last_error_at, updated_at
)
SELECT
  day, provider_id, operation, request_count, success_count, error_count,
  delegated_count, latency_total_ms, downgrade_count,
  last_error_code, last_error_message, last_error_at, updated_at
FROM music_provider_health_daily;

DROP TABLE music_provider_health_daily;
ALTER TABLE music_provider_health_daily_next RENAME TO music_provider_health_daily;

CREATE INDEX music_provider_health_updated_at_idx
ON music_provider_health_daily(updated_at);
