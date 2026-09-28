CREATE TABLE import_locks (
  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  payload_hash TEXT NOT NULL
);
-- An interrupted import remains locked until the same payload is resumed successfully.
CREATE TRIGGER monitors_import_lock BEFORE UPDATE ON monitors
WHEN EXISTS (SELECT 1 FROM import_locks WHERE monitor_id=OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'history import in progress');
END;
