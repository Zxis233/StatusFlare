-- Bound scheduled cleanup work by time, not by full-table scans.
CREATE INDEX results_retention ON check_results(checked_at,id);
CREATE INDEX jobs_retention ON check_jobs(state,scheduled_at);
CREATE INDEX stats_retention ON daily_stats(day);
CREATE INDEX outages_retention ON monitor_outages(end_at);
CREATE INDEX outbox_retention ON notification_outbox(state,created_at);
CREATE INDEX audit_recent ON audit_logs(created_at);
ALTER TABLE events ADD COLUMN published_at INTEGER;
UPDATE events SET published_at=created_at WHERE published=1;
