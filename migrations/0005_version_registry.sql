PRAGMA foreign_keys = ON;

CREATE TABLE version_products (
  product_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  product_type TEXT NOT NULL CHECK (product_type IN ('web', 'service', 'desktop', 'mobile')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE version_releases (
  id TEXT PRIMARY KEY,
  product_key TEXT NOT NULL REFERENCES version_products(product_key) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  build_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'published', 'paused', 'withdrawn')),
  minimum_version TEXT NOT NULL DEFAULT '0.0.0',
  rollout_percentage INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percentage BETWEEN 0 AND 100),
  rollout_salt TEXT NOT NULL,
  release_notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  source_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (product_key, channel, version, build_id)
);

CREATE INDEX version_releases_product_idx
ON version_releases(product_key, channel, updated_at DESC);

CREATE INDEX version_releases_status_idx
ON version_releases(status, updated_at DESC);

CREATE TABLE version_artifacts (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES version_releases(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  action_type TEXT NOT NULL,
  url TEXT NOT NULL,
  fallback_url TEXT,
  label TEXT,
  signature TEXT,
  sha256 TEXT,
  size INTEGER,
  tauri_target TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (release_id, target)
);

CREATE INDEX version_artifacts_release_idx ON version_artifacts(release_id);

CREATE TABLE version_deployments (
  id TEXT PRIMARY KEY,
  product_key TEXT NOT NULL REFERENCES version_products(product_key) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  version TEXT NOT NULL,
  build_id TEXT NOT NULL,
  commit_sha TEXT,
  deployment_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'failed', 'unknown')),
  deployed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (product_key, environment, build_id)
);

CREATE INDEX version_deployments_product_idx
ON version_deployments(product_key, environment, deployed_at DESC);

CREATE TABLE version_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  channel TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  detail_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX version_sync_log_created_at_idx ON version_sync_log(created_at DESC);

INSERT INTO version_products (product_key, display_name, product_type, sort_order, active, created_at, updated_at) VALUES
  ('echora-web', 'Echora Web', 'web', 10, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('echora-cloud', 'Echora Cloud', 'service', 20, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('echora-desktop', 'Echora 桌面端', 'desktop', 30, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('echora-android', 'Echora Android', 'mobile', 40, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('echora-ios', 'Echora iOS', 'mobile', 50, 1, unixepoch() * 1000, unixepoch() * 1000);
