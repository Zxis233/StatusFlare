-- Compact free-mode storage. Existing relational history is retained and read alongside it.
ALTER TABLE monitors ADD COLUMN manual_check_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE free_runtime (
  id INTEGER PRIMARY KEY CHECK(id=1),
  state TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state)),
  attempts TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(attempts)),
  slot INTEGER NOT NULL DEFAULT -1,
  token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO free_runtime(id) VALUES (1);
CREATE TABLE free_history (
  hour INTEGER PRIMARY KEY,
  samples TEXT NOT NULL CHECK(json_valid(samples))
);
CREATE TABLE free_daily (
  day INTEGER PRIMARY KEY,
  totals TEXT NOT NULL CHECK(json_valid(totals))
);
-- A read-only compatibility view: newer paid/legacy state wins if modes are switched.
CREATE VIEW current_monitor_state AS
WITH compact AS (
  SELECT j.key AS monitor_id,
    json_extract(j.value,'$.status') AS status,
    json_extract(j.value,'$.checked_at') AS checked_at,
    json_extract(j.value,'$.latency') AS latency,
    json_extract(j.value,'$.version') AS version,
    json_extract(j.value,'$.failure_since') AS failure_since,
    json_extract(j.value,'$.alerted') AS alerted,
    json_extract(j.value,'$.result_id') AS result_id
  FROM free_runtime r, json_each(r.state) j WHERE r.id=1
)
SELECT c.* FROM compact c WHERE NOT EXISTS (
  SELECT 1 FROM monitor_state s WHERE s.monitor_id=c.monitor_id AND s.checked_at>c.checked_at
)
UNION ALL
SELECT s.* FROM monitor_state s WHERE NOT EXISTS (
  SELECT 1 FROM compact c WHERE c.monitor_id=s.monitor_id AND c.checked_at>=s.checked_at
);
