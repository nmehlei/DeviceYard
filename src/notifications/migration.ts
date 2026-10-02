// Events are captured by the same SQLite statement as the terminal job write,
// including startup reconciliation. No network or rendering runs in this path.
export const NOTIFICATION_MIGRATION = `
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
CREATE TABLE notification_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('off','failures','all')),
  PRIMARY KEY(user_id, org_id)
);
CREATE TABLE notification_health_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE notification_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('invitation','password-reset','email-verification')),
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  closed_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  org_id INTEGER,
  payload TEXT NOT NULL,
  recipients TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  org_id INTEGER REFERENCES orgs(id) ON DELETE SET NULL,
  action_id TEXT REFERENCES notification_actions(id) ON DELETE SET NULL,
  incident_id TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_owner TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX notification_outbox_due ON notification_outbox(status, available_at);
CREATE TABLE notification_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id TEXT NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE notification_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE TABLE notification_incidents (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  incident_id TEXT,
  offline_since INTEGER,
  recovered_at INTEGER,
  last_observed_at INTEGER NOT NULL,
  alerted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE notification_recoveries (
  incident_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  offline_since INTEGER NOT NULL,
  recovered_at INTEGER NOT NULL
);
CREATE TRIGGER notification_job_terminal AFTER UPDATE OF status ON jobs
WHEN OLD.status IN ('queued','running') AND NEW.status IN ('done','failed')
BEGIN
  INSERT OR IGNORE INTO notification_events(id,org_id,payload,recipients,created_at)
  SELECT 'run:' || NEW.id, o.id,
    json_object('jobId', NEW.id, 'orgName', o.name, 'orgId', o.id,
      'failed', CASE WHEN NEW.status='failed' OR EXISTS(
        SELECT 1 FROM flow_runs WHERE job_id=NEW.id AND status='failed') THEN 1 ELSE 0 END,
      'passedCount',(SELECT COUNT(*) FROM flow_runs WHERE job_id=NEW.id AND kind='flow' AND status='passed'),
      'failedCount',(SELECT COUNT(*) FROM flow_runs WHERE job_id=NEW.id AND kind='flow' AND status='failed'),
      'durationMs', MAX(0, COALESCE(NEW.finished_at,0)-COALESCE(NEW.started_at,NEW.created_at)),
      'failedFlows',json((SELECT json_group_array(name) FROM
        (SELECT substr(name,1,160) AS name FROM flow_runs WHERE job_id=NEW.id AND kind='flow' AND status='failed' ORDER BY ordinal LIMIT 10)))),
    (SELECT json_group_array(u.id) FROM users u
      JOIN org_members m ON m.user_id=u.id AND m.org_id=o.id
      JOIN notification_preferences p ON p.user_id=u.id AND p.org_id=o.id
      WHERE u.deactivated_at IS NULL AND u.email_verified_at IS NOT NULL
        AND (p.mode='all' OR (p.mode='failures' AND (NEW.status='failed' OR EXISTS(
          SELECT 1 FROM flow_runs WHERE job_id=NEW.id AND status='failed'))))),
    COALESCE(NEW.finished_at, NEW.created_at)
  FROM orgs o WHERE o.name=NEW.org AND o.archived_at IS NULL;
END;
`;
