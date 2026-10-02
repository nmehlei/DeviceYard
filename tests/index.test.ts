import fs from "fs";
import os from "os";
import path from "path";
import { bootstrap } from "../src/index";
import { openDatabase } from "../src/db/driver";
import { OrgRepository } from "../src/store/orgRepository";
import { OrgTokenRepository } from "../src/store/orgTokenRepository";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-boot-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// SESSION_SECRET must clear loadConfig's 32-character minimum (see
// config.test.ts) - a short value here would fail bootstrap for a reason
// unrelated to what these tests exercise.
function env(): NodeJS.ProcessEnv {
  return {
    TOKENS_JSON: '{"donable":"t"}',
    DEVICE_ID: "emulator-5554",
    SESSION_SECRET: "a".repeat(32),
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "bootstrap-password",
    ADMIN_EMAIL: "admin@example.com",
    TOKEN_ENCRYPTION_KEY: "0".repeat(64),
    DATA_DIR: dataDir,
  } as NodeJS.ProcessEnv;
}

test("bootstrap creates the database and applies migrations", () => {
  const { repo } = bootstrap(env());

  expect(fs.existsSync(path.join(dataDir, "farm.db"))).toBe(true);
  expect(repo.listJobs("donable")).toEqual([]);
});

test("bootstrap closes jobs abandoned by the previous process", () => {
  const first = bootstrap(env());
  const job = first.repo.createJob("donable", ["a"]);
  first.repo.markJobRunning(job.id);

  const second = bootstrap(env());

  expect(second.repo.getJob(job.id)?.status).toBe("failed");
  expect(second.repo.getJob(job.id)?.error).toBe("interrupted by restart");
});

// D-4: the queue is the jobs table now, so a job's ROW survives a restart -
// but its payload does not (the apk and flows archive live under UPLOAD_DIR,
// a temp directory, and the resolved app id lives in server.ts's in-memory
// maps). So a job left `queued` by the dead process is CLOSED at boot, not
// dispatched: same terminal state as the running one, for the same reason.
test("a restart closes both the running and the queued job left by the previous process", () => {
  const first = bootstrap(env());
  const running = first.repo.createJob("donable", ["a"]);
  first.repo.markJobRunning(running.id);
  const queued = first.repo.createJob("donable", ["b"]);
  expect(first.repo.getJob(queued.id)?.status).toBe("queued");

  const second = bootstrap(env());

  expect(second.repo.getJob(running.id)?.status).toBe("failed");
  expect(second.repo.getJob(running.id)?.error).toBe("interrupted by restart");
  expect(second.repo.getJob(queued.id)?.status).toBe("failed");
  expect(second.repo.getJob(queued.id)?.error).toBe("interrupted by restart");
});

test("bootstrap returns a stopScheduler that is safe to call", () => {
  const { stopScheduler } = bootstrap(env());

  expect(() => stopScheduler()).not.toThrow();
});

test("bootstrap surfaces a malformed TOKENS_JSON clearly", () => {
  expect(() => bootstrap({ ...env(), TOKENS_JSON: "{oops" } as NodeJS.ProcessEnv)).toThrow(
    /TOKENS_JSON is not valid JSON/
  );
});

// Blocker 2b: a process that dies mid-flow (the update timer restarts on
// every merge, exactly when jobs can be running) can leave debug/<jobId>
// directories behind holding real screenshots unreferenced by the artifacts
// table - invisible to totalArtifactBytes(), the only early warning the host
// is filling up. This is only safe to purge wholesale at boot, before
// anything is running.
test("bootstrap purges a pre-existing stale debug tree", () => {
  const staleDebugDir = path.join(dataDir, "debug", "some-old-job", "0");
  fs.mkdirSync(staleDebugDir, { recursive: true });
  fs.writeFileSync(path.join(staleDebugDir, "screenshot-1.png"), "stale-bytes");

  bootstrap(env());

  expect(fs.existsSync(path.join(dataDir, "debug"))).toBe(false);
});

// Blocker 3: openDatabase creates DATA_DIR recursively, so first boot only
// succeeds if the service user can write the parent directory. The design
// spec promises this fails "fatal with a clear message", not a raw EACCES
// stack - assert DATA_DIR is named in the thrown error.
test("bootstrap surfaces an unwritable DATA_DIR parent with a clear message naming DATA_DIR", () => {
  const readOnlyParent = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-boot-ro-"));
  fs.chmodSync(readOnlyParent, 0o500);
  const unwritableDataDir = path.join(readOnlyParent, "data");

  try {
    expect(() => bootstrap({ ...env(), DATA_DIR: unwritableDataDir } as NodeJS.ProcessEnv)).toThrow(
      new RegExp(unwritableDataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
  } finally {
    fs.chmodSync(readOnlyParent, 0o700);
    fs.rmSync(readOnlyParent, { recursive: true, force: true });
  }
});

test("bootstrap seeds exactly one admin user and one org per TOKENS_JSON entry on first boot", () => {
  bootstrap(env());

  const db = openDatabase(path.join(dataDir, "farm.db"));
  const userCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM users");
  const adminRow = db.get<{ username: string; is_admin: number }>("SELECT username, is_admin FROM users LIMIT 1");
  const orgRow = db.get<{ name: string }>("SELECT name FROM orgs WHERE name = ?", "donable");
  const tokenCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM org_tokens");

  expect(userCount?.c).toBe(1);
  expect(adminRow).toMatchObject({ username: "admin", is_admin: 1 });
  expect(orgRow?.name).toBe("donable");
  expect(tokenCount?.c).toBe(1);
  db.close();
});

// I2: revoking the system's only token drives org_tokens back to zero rows -
// a legitimate operator action, not "orgs was never populated." The next
// restart must not treat that as a first-boot signal and silently
// resurrect the legacy TOKENS_JSON token.
test("revoking the only token does not get silently re-seeded by the next boot", () => {
  bootstrap(env());

  const db = openDatabase(path.join(dataDir, "farm.db"));
  const orgRepo = new OrgRepository(db);
  const orgTokenRepo = new OrgTokenRepository(db, "0".repeat(64));
  const org = orgRepo.getByName("donable")!;
  const [token] = orgTokenRepo.list(org.id);
  orgTokenRepo.revoke(token.id, org.id);
  expect(orgTokenRepo.list(org.id)).toEqual([]);
  db.close();

  bootstrap(env());

  const db2 = openDatabase(path.join(dataDir, "farm.db"));
  const orgTokenRepo2 = new OrgTokenRepository(db2, "0".repeat(64));
  expect(orgTokenRepo2.list(org.id)).toEqual([]);
  expect(orgTokenRepo2.findActiveOrgNameByRawToken("t")).toBeUndefined();
  db2.close();
});

test("bootstrap does not re-seed admin/orgs on a second boot against the same DATA_DIR", () => {
  bootstrap(env());
  bootstrap(env());

  const db = openDatabase(path.join(dataDir, "farm.db"));
  const userCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM users");
  const orgCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM orgs");
  expect(userCount?.c).toBe(1);
  expect(orgCount?.c).toBe(1);
  db.close();
});

test("bootstrap starts the retention sweep, which is a no-op with no settings saved", () => {
  const { repo } = bootstrap(env());
  const job = repo.createJob("donable", ["a"]);
  repo.markJobRunning(job.id);
  repo.finishJob(job.id, "done");

  // The sweep's first tick runs synchronously-scheduled but asynchronously
  // (fire-and-forget) inside bootstrap - by the time bootstrap() has
  // returned, the promise may not have settled yet. Retention defaults to
  // fully disabled, so there is nothing to await: the job must still exist
  // immediately, with no timing dependency either way.
  expect(repo.getJob(job.id)).toBeDefined();
});

test("bootstrap wires retention so a saved max-jobs:0 setting evicts a finished job on the next boot", async () => {
  const first = bootstrap(env());
  const job = first.repo.createJob("donable", ["a"]);
  first.repo.markJobRunning(job.id);
  first.repo.finishJob(job.id, "done");
  first.repo.setRetentionSettings({ maxAgeDays: null, maxTotalBytes: null, maxJobs: 0 });

  // startRetentionSweep's immediate tick runs synchronously inside
  // bootstrap() itself, BEFORE this test has created the job or saved
  // settings above - so eviction can only be observed on a SECOND boot's
  // immediate tick, not the first's. Mirrors the existing "closes jobs
  // abandoned by the previous process" test's first/second bootstrap()
  // pattern just above.
  const second = bootstrap(env());

  // The second boot's sweep tick is fire-and-forget (not awaited by
  // bootstrap), so give it a moment to complete before asserting.
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(second.repo.getJob(job.id)).toBeUndefined();
});
