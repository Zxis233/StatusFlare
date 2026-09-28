ALTER TABLE monitors ADD COLUMN free_lease_token TEXT;
ALTER TABLE monitors ADD COLUMN free_lease_until INTEGER NOT NULL DEFAULT 0;
CREATE TABLE free_usage (
  day INTEGER PRIMARY KEY,
  checks INTEGER NOT NULL DEFAULT 0,
  check_slot INTEGER NOT NULL DEFAULT -1,
  deliveries INTEGER NOT NULL DEFAULT 0,
  imports INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0,
  cleanup_slot INTEGER NOT NULL DEFAULT -1
);
INSERT OR IGNORE INTO settings VALUES ('public_revision','0');
-- Permit a default switch from the earlier paid-oriented branch without destroying history.
-- Interval changes also invalidate any older in-flight probe results.
UPDATE monitors SET interval=MAX(interval,600,60*(SELECT COUNT(*) FROM monitors WHERE enabled=1)),version=version+1,next_check_at=0 WHERE enabled=1 AND NOT EXISTS(SELECT 1 FROM import_locks WHERE monitor_id=monitors.id);
