-- A device installation represents one active account session. Keep the most
-- recently used row before enforcing that invariant for future logins.
DELETE FROM sessions
WHERE EXISTS (
  SELECT 1
  FROM sessions AS newer
  WHERE newer.user_id = sessions.user_id
    AND newer.device_id = sessions.device_id
    AND (
      newer.last_seen_at > sessions.last_seen_at
      OR (newer.last_seen_at = sessions.last_seen_at AND newer.created_at > sessions.created_at)
      OR (newer.last_seen_at = sessions.last_seen_at AND newer.created_at = sessions.created_at AND newer.id > sessions.id)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_user_device_unique_idx
ON sessions(user_id, device_id);
