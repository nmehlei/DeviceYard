import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate, SCHEMA_VERSION } from "../../src/db/migrations";

let dir: string;
let db: Db;

beforeEach(() => {
  // A real file, not :memory: - WAL mode and file locking are part of what
  // this code has to get right, and :memory: exercises neither.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-db-"));
  db = openDatabase(path.join(dir, "farm.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("migrating an empty database creates every table", () => {
  expect(migrate(db)).toBe(SCHEMA_VERSION);

  const names = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((r) => r.name)
    .sort();

  expect(names).toEqual(
    expect.arrayContaining([
      "artifacts",
      "flow_runs",
      "jobs",
      "devices",
      "device_events",
      "users",
      "orgs",
      "org_members",
      "org_tokens",
      "upload_settings",
    ])
  );
});

test("migrating is idempotent", () => {
  migrate(db);
  db.run("INSERT INTO jobs (id, org, status, created_at) VALUES (?, ?, ?, ?)", "j1", "donable", "queued", 1);

  expect(migrate(db)).toBe(SCHEMA_VERSION);

  expect(db.all<{ id: string }>("SELECT id FROM jobs")).toHaveLength(1);
});

test("user_version records the applied schema version", () => {
  migrate(db);
  const row = db.get<{ user_version: number }>("PRAGMA user_version");
  expect(row?.user_version).toBe(SCHEMA_VERSION);
});

test("WAL mode is enabled so readers never block the writer", () => {
  const row = db.get<{ journal_mode: string }>("PRAGMA journal_mode");
  expect(row?.journal_mode.toLowerCase()).toBe("wal");
});

test("foreign keys cascade so deleting a job removes its rows", () => {
  migrate(db);
  db.run("INSERT INTO jobs (id, org, status, created_at) VALUES (?, ?, ?, ?)", "j1", "donable", "queued", 1);
  db.run(
    "INSERT INTO flow_runs (job_id, ordinal, kind, name, status) VALUES (?, ?, ?, ?, ?)",
    "j1",
    0,
    "flow",
    "map/map",
    "queued"
  );

  db.run("DELETE FROM jobs WHERE id = ?", "j1");

  expect(db.all("SELECT id FROM flow_runs")).toHaveLength(0);
});

test("migrating creates the retention_settings table", () => {
  migrate(db);
  const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  expect(names).toContain("retention_settings");
});

test("migration 9 adds device_id, its index, and scheduler settings", () => {
  const db = openDatabase(path.join(dir, "fresh.db"));
  migrate(db);

  const jobColumns = db.all<{ name: string }>("PRAGMA table_info(jobs)").map((c) => c.name);
  expect(jobColumns).toContain("device_id");

  const indexes = db.all<{ name: string }>("PRAGMA index_list(jobs)").map((i) => i.name);
  expect(indexes).toContain("idx_jobs_status_created");

  const settingsColumns = db
    .all<{ name: string }>("PRAGMA table_info(scheduler_settings)")
    .map((c) => c.name);
  expect(settingsColumns).toEqual(expect.arrayContaining(["id", "max_concurrent_jobs", "updated_at"]));

  db.close();
});

test("device_id survives the device row being deleted", () => {
  const db = openDatabase(path.join(dir, "fk.db"));
  migrate(db);
  db.run("INSERT INTO devices (id, label, model, is_active, added_at) VALUES ('R58N', 'S10', NULL, 1, 1)");
  db.run(
    "INSERT INTO jobs (id, org, status, created_at, device_id) VALUES ('j1', 'donable', 'done', 1, 'R58N')"
  );

  db.run("DELETE FROM devices WHERE id = 'R58N'");

  const job = db.get<{ device_id: string | null }>("SELECT device_id FROM jobs WHERE id = 'j1'");
  expect(job?.device_id).toBeNull();
  db.close();
});

test("migration 11 adds app_id and app_version to jobs, both nullable", () => {
  const db = openDatabase(path.join(dir, "app-info.db"));
  migrate(db);

  const jobColumns = db.all<{ name: string; notnull: number }>("PRAGMA table_info(jobs)");
  const appId = jobColumns.find((c) => c.name === "app_id");
  const appVersion = jobColumns.find((c) => c.name === "app_version");
  expect(appId).toBeTruthy();
  expect(appId?.notnull).toBe(0);
  expect(appVersion).toBeTruthy();
  expect(appVersion?.notnull).toBe(0);

  db.run("INSERT INTO jobs (id, org, status, created_at) VALUES ('j1', 'donable', 'done', 1)");
  const row = db.get<{ app_id: string | null; app_version: string | null }>(
    "SELECT app_id, app_version FROM jobs WHERE id = 'j1'"
  );
  expect(row?.app_id).toBeNull();
  expect(row?.app_version).toBeNull();

  db.close();
});

test("upload_settings is a singleton keyed on id = 1", () => {
  migrate(db);

  db.run("INSERT INTO upload_settings (id, max_upload_bytes, updated_at) VALUES (1, ?, ?)", 1024, 1);
  // The CHECK constraint is what keeps effectiveUploadLimit's "WHERE id = 1"
  // read total: a second row would make the setting ambiguous.
  expect(() =>
    db.run("INSERT INTO upload_settings (id, max_upload_bytes, updated_at) VALUES (2, ?, ?)", 2048, 2)
  ).toThrow();
});

test("a database already at version 6 migrates forward to upload_settings", () => {
  // Simulates an existing deployment: migrate, then rewind user_version to 6
  // and drop the new table, so `migrate` has to apply exactly MIGRATION_7.
  migrate(db);

  // Populate the table MIGRATION_9 alters, the way the farm's real database
  // is populated on the next deploy - a fresh-database test would not catch
  // a variant of MIGRATION_9 that only breaks against existing rows.
  db.run("INSERT INTO devices (id, label, model, is_active, added_at) VALUES ('R58N', 'S10', NULL, 1, 1)");
  db.run("INSERT INTO jobs (id, org, status, created_at) VALUES ('j1', 'donable', 'done', 1)");

  db.exec("DROP TRIGGER notification_job_terminal");
  for (const table of ["notification_attempts", "notification_outbox", "notification_actions", "notification_events", "notification_preferences", "notification_health_preferences", "notification_rate_limits", "notification_incidents", "notification_recoveries"]) {
    db.exec(`DROP TABLE ${table}`);
  }
  db.exec("ALTER TABLE users DROP COLUMN session_version");
  db.exec("ALTER TABLE users DROP COLUMN email_verified_at");
  db.exec("DROP TABLE upload_settings");
  db.exec("DROP TABLE edition_settings");
  db.exec("DROP INDEX IF EXISTS idx_jobs_status_created");
  db.exec("DROP TABLE IF EXISTS scheduler_settings");
  db.exec("ALTER TABLE jobs DROP COLUMN device_id");
  db.exec("ALTER TABLE devices DROP COLUMN reset_policy");
  db.exec("ALTER TABLE jobs DROP COLUMN app_id");
  db.exec("ALTER TABLE jobs DROP COLUMN app_version");
  db.exec("PRAGMA user_version = 6");

  expect(migrate(db)).toBe(SCHEMA_VERSION);
  expect(
    db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'upload_settings'")
  ).toBeTruthy();

  const jobColumns = db.all<{ name: string }>("PRAGMA table_info(jobs)").map((c) => c.name);
  expect(jobColumns).toContain("device_id");

  expect(
    db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_settings'")
  ).toBeTruthy();

  const job = db.get<{ device_id: string | null }>("SELECT device_id FROM jobs WHERE id = 'j1'");
  expect(job).toBeTruthy();
  expect(job?.device_id).toBeNull();

  // The device enrolled before MIGRATION_10 existed must land on the weakest
  // policy. Anything else would start clearing a real person's browser on the
  // next job purely because the farm was upgraded.
  const device = db.get<{ reset_policy: string }>("SELECT reset_policy FROM devices WHERE id = 'R58N'");
  expect(device?.reset_policy).toBe("app-only");
});

test("migration 10 adds reset_policy defaulting to app-only", () => {
  migrate(db);

  const columns = db.all<{ name: string; dflt_value: string | null; notnull: number }>(
    "PRAGMA table_info(devices)"
  );
  const column = columns.find((c) => c.name === "reset_policy");

  expect(column).toBeTruthy();
  expect(column?.notnull).toBe(1);

  db.run("INSERT INTO devices (id, label, model, is_active, added_at) VALUES ('R99', 'new', NULL, 1, 1)");
  const inserted = db.get<{ reset_policy: string }>("SELECT reset_policy FROM devices WHERE id = 'R99'");
  expect(inserted?.reset_policy).toBe("app-only");
});

test("SCHEMA_VERSION is 12", () => {
  expect(SCHEMA_VERSION).toBe(12);
});
