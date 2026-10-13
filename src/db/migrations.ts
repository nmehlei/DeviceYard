import type { Db } from "./driver";
import { NOTIFICATION_MIGRATION } from "../notifications/migration";

const MIGRATION_1 = `
CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  org         TEXT NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);

-- One row per step, including setup steps. Setup work (device prep, install,
-- extract) used to be smuggled back as fake flow results named <device>,
-- <install> and <extract>; as rows with kind = 'setup' they share the job
-- timeline honestly and stay out of per-flow flakiness statistics.
CREATE TABLE flow_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL,
  exit_code      INTEGER,
  started_at     INTEGER,
  finished_at    INTEGER,
  -- The resolved path Maestro was actually given. The frozen CI contract
  -- reports this as results[].flow, so it has to be stored, not recomputed.
  resolved_path  TEXT,
  artifact_dir   TEXT,
  warnings       TEXT,
  stdout_preview TEXT,
  stderr_preview TEXT
);

-- Large output stays on disk; only its location and size live here, so list
-- views stay fast and SUM(bytes) answers "what is this costing us".
CREATE TABLE artifacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_run_id  INTEGER NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_jobs_org_created ON jobs (org, created_at DESC);
CREATE INDEX idx_flow_runs_job ON flow_runs (job_id, ordinal);
-- Exists solely so the flakiness views in cycle 3 are a GROUP BY and not a
-- full scan. Cheap now, expensive to add once the table is large.
CREATE INDEX idx_flow_runs_name ON flow_runs (name, finished_at DESC);
CREATE INDEX idx_artifacts_flow_run ON artifacts (flow_run_id);
`;

// id is the adb serial - a property of the physical device, not of the USB
// port or the process that discovered it - so the same phone reconnected
// after being unplugged, or after this service restarts, always maps back
// to this same row rather than spawning a duplicate.
const MIGRATION_2 = `
CREATE TABLE devices (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  -- Last-seen \`ro.product.model\`, cached so a currently-disconnected
  -- device still shows what it is instead of going blank. NULL until the
  -- device has been observed online at least once.
  model       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 0,
  added_at    INTEGER NOT NULL
);

-- Append-only: state transitions the ops endpoint notices between polls,
-- plus operator-triggered actions (reboot, screenshot, activate, add).
CREATE TABLE device_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  detail      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_device_events_device ON device_events (device_id, created_at DESC);
`;

// id is the surrogate key throughout - usernames/org names can change
// (rename), so nothing downstream should ever join on them directly except
// jobs.org, which intentionally stores the org *name* as a point-in-time
// snapshot (see the spec's "jobs.org stays exactly as it is" decision).
const MIGRATION_3 = `
CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  is_admin        INTEGER NOT NULL DEFAULT 0,
  deactivated_at  INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE orgs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE org_members (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id          INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, org_id)
);

-- token_hash is a SHA-256 hex digest of the raw token, used for O(1) lookup
-- on the CI bearer-auth path (WHERE token_hash = ?) without decrypting every
-- row on every request. token_encrypted is the AES-256-GCM ciphertext,
-- decrypted only when a human asks to view it (GET /api/orgs/:id/tokens).
CREATE TABLE org_tokens (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id              INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  token_encrypted     TEXT NOT NULL,
  token_hash          TEXT NOT NULL UNIQUE,
  created_at          INTEGER NOT NULL,
  created_by_user_id  INTEGER REFERENCES users(id)
);

CREATE INDEX idx_org_members_org ON org_members (org_id);
CREATE INDEX idx_org_tokens_org ON org_tokens (org_id);
`;

// Singleton (id is always 1) rather than a generic key/value table:
// retention is the only server-wide setting today, and a typed row is
// simpler to read and validate than a key/value blob for three integers. No
// row present means every threshold is disabled - the retention sweep
// (src/retention.ts) treats a missing row identically to an all-NULL one,
// so a fresh install's behavior is unchanged until an admin opts in.
const MIGRATION_4 = `
CREATE TABLE retention_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  max_age_days     INTEGER,
  max_total_bytes  INTEGER,
  max_jobs         INTEGER,
  updated_at       INTEGER NOT NULL
);
`;

// Personal access tokens: the same shape as org_tokens but keyed on a
// person, so one credential can act across every org they belong to. Kept
// as its own table rather than making org_tokens polymorphic - a NULL
// org_id reaching the CI bearer-auth path would be a silent authorization
// bug in the one place that must never have one.
const MIGRATION_5 = `
CREATE TABLE user_tokens (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label            TEXT NOT NULL,
  token_encrypted  TEXT NOT NULL,
  token_hash       TEXT NOT NULL UNIQUE,
  created_at       INTEGER NOT NULL,
  last_used_at     INTEGER
);

CREATE INDEX idx_user_tokens_user ON user_tokens (user_id);
`;

// Nullable on purpose: every job written before this cycle has no env, and a
// job sent WITHOUT an env must stay distinguishable from one sent with {}.
const MIGRATION_6 = `
ALTER TABLE jobs ADD COLUMN env_json TEXT;
`;

// The second server-wide setting, deliberately its own singleton rather than
// a column on retention_settings - an upload cap in a table named for
// retention would be a lie in the schema. MIGRATION_4's comment claimed
// retention was "the only server-wide setting today"; that is no longer
// true. A THIRD such setting should consolidate both into one
// server_settings table rather than adding a third singleton here.
//
// max_upload_bytes NULL does not mean "default" - it means "no limit",
// deliberately set by an admin. A fresh install has no row at all, and that
// absence is what yields DEFAULT_MAX_UPLOAD_BYTES. Row existence, not the
// column, carries the difference between "never configured" and "configured
// as unlimited".
const MIGRATION_7 = `
CREATE TABLE upload_settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  max_upload_bytes  INTEGER,
  updated_at        INTEGER NOT NULL
);
`;

// Cycle 10, multi-device scheduling.
//
// NOTE ON is_active: this cycle REINTERPRETS devices.is_active rather than
// altering it. It stops meaning "the one device jobs run against" and starts
// meaning "enrolled in the pool and accepting work". No data change is needed
// - an existing deployment's single active device comes up as a pool of one,
// behaving exactly as before.
//
// device_id must stay nullable with no default: the driver runs
// PRAGMA foreign_keys = ON, and SQLite refuses ADD COLUMN with a REFERENCES
// clause unless the new column defaults to NULL. A NOT NULL or non-NULL
// default here does not work, now or later.
const MIGRATION_9 = `
ALTER TABLE jobs ADD COLUMN device_id TEXT REFERENCES devices(id) ON DELETE SET NULL;

-- Serves the claim's "WHERE status='queued' ORDER BY created_at" subquery and
-- the "WHERE status='running'" free-device derivation. Both run on every
-- dispatch, where before they ran never.
CREATE INDEX idx_jobs_status_created ON jobs (status, created_at);

-- Same single-row shape as retention_settings and upload_settings.
-- max_concurrent_jobs NULL means "no cap": one job per enrolled device.
CREATE TABLE scheduler_settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  max_concurrent_jobs INTEGER,
  updated_at          INTEGER NOT NULL
);
`;

// Reset policy is a property of the DEVICE, never of a job. Flows must run
// byte-identical against DeviceCloud and DeviceYard, so how aggressively a
// handset resets itself cannot leak into the job API. See
// docs/superpowers/specs/2026-09-18-device-reset-policy-design.md
//
// The default is deliberately the weakest setting: the farm's current handset
// is somebody's personal phone, and anything stronger deletes their data.
// Every existing row lands on 'app-only', which is exactly today's behaviour.
const MIGRATION_10 = `
ALTER TABLE devices ADD COLUMN reset_policy TEXT NOT NULL DEFAULT 'app-only';
`;

// app_id/app_version are resolved from the uploaded APK's manifest at
// submit time (see src/appId.ts and src/server.ts) but were only ever kept
// in an in-memory map for install/uninstall commands - never persisted.
// Both stay nullable with no default: existing rows before this migration
// have no way to retroactively know what app they ran.
const MIGRATION_11 = `
ALTER TABLE jobs ADD COLUMN app_id TEXT;
ALTER TABLE jobs ADD COLUMN app_version TEXT;
`;

const MIGRATIONS: string[] = [
  MIGRATION_1,
  MIGRATION_2,
  MIGRATION_3,
  MIGRATION_4,
  MIGRATION_5,
  MIGRATION_6,
  MIGRATION_7,
  NOTIFICATION_MIGRATION,
  MIGRATION_9,
  MIGRATION_10,
  MIGRATION_11,
  `CREATE TABLE edition_settings (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    community_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
    selection_initialized INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO edition_settings(singleton, community_device_id, selection_initialized)
    SELECT 1, CASE WHEN COUNT(*) = 1 THEN MIN(id) ELSE NULL END,
      CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END FROM devices WHERE is_active = 1;`,
  `CREATE TABLE maintenance_settings (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    requested INTEGER NOT NULL DEFAULT 0 CHECK(requested IN (0,1))
  );
  INSERT INTO maintenance_settings(singleton, requested) VALUES (1, 0);`,
  `ALTER TABLE devices ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE jobs ADD COLUMN required_device_tags_json TEXT NOT NULL DEFAULT '[]';`,
];

export const SCHEMA_VERSION = 14;

export function migrate(db: Db): number {
  const row = db.get<{ user_version: number }>("PRAGMA user_version");
  const current = row?.user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      // PRAGMA does not accept bound parameters; the value is a loop counter,
      // never user input.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return SCHEMA_VERSION;
}
