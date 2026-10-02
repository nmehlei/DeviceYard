import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository, SETUP_STEPS } from "../../src/store/jobRepository";

let dir: string;
let db: Db;
let repo: JobRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-repo-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createJob stores the job as queued", () => {
  const job = repo.createJob("donable", ["map/map", "donation/donation"]);

  expect(job.org).toBe("donable");
  expect(job.status).toBe("queued");
  expect(job.error).toBeNull();
  expect(typeof job.id).toBe("string");
  expect(typeof job.createdAt).toBe("number");
  expect(job.startedAt).toBeNull();
});

test("createJob lays out setup steps before flow steps, all queued", () => {
  const job = repo.createJob("donable", ["map/map", "donation/donation"]);
  const steps = repo.getSteps(job.id);

  expect(steps.map((s) => s.name)).toEqual([...SETUP_STEPS, "map/map", "donation/donation"]);
  expect(steps.map((s) => s.kind)).toEqual(["setup", "setup", "setup", "flow", "flow"]);
  expect(steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4]);
  expect(steps.every((s) => s.status === "queued")).toBe(true);
});

test("ids are unique across rapid creation", () => {
  const ids = new Set(Array.from({ length: 50 }, () => repo.createJob("donable", ["a"]).id));
  expect(ids.size).toBe(50);
});

test("getJob returns undefined for an unknown id", () => {
  expect(repo.getJob("nope")).toBeUndefined();
});

test("listJobs returns only the org's jobs, newest first", () => {
  let clock = 1000;
  const timed = new JobRepository(db, () => (clock += 1000));

  const first = timed.createJob("donable", ["a"]);
  const other = timed.createJob("other", ["a"]);
  const second = timed.createJob("donable", ["b"]);

  const mine = timed.listJobs("donable");
  expect(mine.map((j) => j.id)).toEqual([second.id, first.id]);
  expect(mine.some((j) => j.id === other.id)).toBe(false);
});

test("listJobs honours a limit", () => {
  let clock = 1000;
  const timed = new JobRepository(db, () => (clock += 1000));
  for (let i = 0; i < 5; i++) timed.createJob("donable", ["a"]);

  expect(timed.listJobs("donable", 2)).toHaveLength(2);
});

test("warnings round-trip as an array, defaulting to empty", () => {
  const job = repo.createJob("donable", ["a"]);
  expect(repo.getSteps(job.id)[0].warnings).toEqual([]);
});

test("listJobs breaks same-millisecond ties by insertion order, not by id", () => {
  // A constant clock forces every job in this test to share created_at, so
  // the tiebreak is the only thing under test. Ids embed a random suffix
  // (see createJob), so an id-based tiebreak would be exercised here too if
  // it were still in use, and would fail non-deterministically.
  const frozen = new JobRepository(db, () => 1000);

  const first = frozen.createJob("donable", ["a"]);
  const second = frozen.createJob("donable", ["b"]);
  const third = frozen.createJob("donable", ["c"]);

  const mine = frozen.listJobs("donable");
  expect(mine.map((j) => j.id)).toEqual([third.id, second.id, first.id]);
});

test("skipRemainingSteps closes a stuck running step as failed, not just queued ones as skipped", () => {
  const job = repo.createJob("donable", ["map/map", "donation/donation"]);
  repo.startStep(job.id, "device");
  repo.finishStep(repo.getSteps(job.id)[0].id, { status: "passed" });
  repo.startStep(job.id, "install"); // left running - simulates a throw mid-step

  repo.skipRemainingSteps(job.id);

  const steps = repo.getSteps(job.id);
  const install = steps.find((s) => s.name === "install");
  const extract = steps.find((s) => s.name === "extract");
  const flow = steps.find((s) => s.name === "map/map");

  expect(install?.status).toBe("failed");
  expect(install?.finishedAt).not.toBeNull();
  expect(extract?.status).toBe("skipped");
  expect(flow?.status).toBe("skipped");
});

test("getRetentionSettings returns undefined before any settings have been saved", () => {
  expect(repo.getRetentionSettings()).toBeUndefined();
});

test("setRetentionSettings saves and getRetentionSettings reads them back", () => {
  const saved = repo.setRetentionSettings({ maxAgeDays: 30, maxTotalBytes: 5_000_000, maxJobs: null });

  expect(saved).toMatchObject({ maxAgeDays: 30, maxTotalBytes: 5_000_000, maxJobs: null });
  expect(repo.getRetentionSettings()).toMatchObject({ maxAgeDays: 30, maxTotalBytes: 5_000_000, maxJobs: null });
});

test("setRetentionSettings overwrites the previous settings, not adds a second row", () => {
  repo.setRetentionSettings({ maxAgeDays: 30, maxTotalBytes: null, maxJobs: null });
  repo.setRetentionSettings({ maxAgeDays: null, maxTotalBytes: null, maxJobs: 50 });

  const row = repo.getRetentionSettings();
  expect(row).toMatchObject({ maxAgeDays: null, maxTotalBytes: null, maxJobs: 50 });
  expect(db.all("SELECT id FROM retention_settings")).toHaveLength(1);
});

test("listEvictableJobs excludes queued/running jobs and sums each job's artifact bytes", () => {
  const done = repo.createJob("donable", ["a"]);
  repo.markJobRunning(done.id);
  repo.finishJob(done.id, "done");
  const [device, install, extract, flow] = repo.getSteps(done.id);
  void device;
  void install;
  void extract;
  repo.recordArtifacts(flow.id, [
    { kind: "screenshot", relPath: `${done.id}/3/final.png`, bytes: 100 },
    { kind: "recording", relPath: `${done.id}/3/recording.mp4`, bytes: 900 },
  ]);

  const stillRunning = repo.createJob("donable", ["b"]);
  repo.markJobRunning(stillRunning.id);

  const evictable = repo.listEvictableJobs();

  expect(evictable.map((j) => j.id)).toEqual([done.id]);
  expect(evictable[0].bytes).toBe(1000);
});

test("listEvictableJobs includes an artifact-less job at 0 bytes", () => {
  const job = repo.createJob("donable", ["a"]);
  repo.markJobRunning(job.id);
  repo.finishJob(job.id, "failed", "boom");

  const evictable = repo.listEvictableJobs();

  expect(evictable).toEqual([{ id: job.id, createdAt: expect.any(Number), bytes: 0 }]);
});

test("listEvictableJobs orders oldest first", () => {
  const first = new JobRepository(db, () => 1000).createJob("donable", ["a"]);
  const second = new JobRepository(db, () => 2000).createJob("donable", ["a"]);
  for (const id of [first.id, second.id]) {
    repo.markJobRunning(id);
    repo.finishJob(id, "done");
  }

  expect(repo.listEvictableJobs().map((j) => j.id)).toEqual([first.id, second.id]);
});

test("deleteJob removes the job and cascades to its flow_runs and artifacts", () => {
  const job = repo.createJob("donable", ["a"]);
  const [, , , flow] = repo.getSteps(job.id);
  repo.recordArtifacts(flow.id, [{ kind: "screenshot", relPath: `${job.id}/3/final.png`, bytes: 10 }]);

  repo.deleteJob(job.id);

  expect(repo.getJob(job.id)).toBeUndefined();
  expect(db.all("SELECT id FROM flow_runs WHERE job_id = ?", job.id)).toHaveLength(0);
  expect(db.all("SELECT id FROM artifacts WHERE flow_run_id = ?", flow.id)).toHaveLength(0);
});

function addDevice(id: string): void {
  db.run("INSERT INTO devices (id, label, model, is_active, added_at) VALUES (?, ?, NULL, 1, 1)", id, id);
}

test("claimNextQueued takes the oldest queued job and assigns the device", () => {
  addDevice("dev-1");
  // Fixed clock so both jobs share created_at and the rowid tiebreak - not
  // whichever millisecond the two createJob calls happen to land in - is
  // what this test actually exercises.
  const fixedRepo = new JobRepository(db, () => 1);
  const first = fixedRepo.createJob("donable", ["map/map"]);
  const second = fixedRepo.createJob("donable", ["donation/donation"]);

  const claimed = repo.claimNextQueued("dev-1");

  expect(claimed?.id).toBe(first.id);
  expect(claimed?.status).toBe("running");
  expect(claimed?.deviceId).toBe("dev-1");
  expect(claimed?.startedAt).not.toBeNull();
  expect(repo.getJob(second.id)?.status).toBe("queued");
});

test("claimNextQueued returns undefined when nothing is queued", () => {
  addDevice("dev-1");
  expect(repo.claimNextQueued("dev-1")).toBeUndefined();
});

test("a job can only be claimed once", () => {
  addDevice("dev-1");
  addDevice("dev-2");
  repo.createJob("donable", ["map/map"]);

  const first = repo.claimNextQueued("dev-1");
  const second = repo.claimNextQueued("dev-2");

  expect(first).toBeDefined();
  expect(second).toBeUndefined();
});

test("a claim loses the race when the row is taken between select and update", () => {
  addDevice("dev-1");
  addDevice("dev-2");
  const job = repo.createJob("donable", ["map/map"]);

  // Simulate the row being claimed by another pass after our SELECT would
  // have seen it: dev-2 takes it directly.
  db.run("UPDATE jobs SET status = 'running', device_id = 'dev-2' WHERE id = ?", job.id);

  expect(repo.claimNextQueued("dev-1")).toBeUndefined();
  expect(repo.getJob(job.id)?.deviceId).toBe("dev-2");
  expect(repo.getJob(job.id)?.status).toBe("running");
});

test("runningDeviceIds and runningCount report claimed devices", () => {
  addDevice("dev-1");
  repo.createJob("donable", ["map/map"]);
  repo.claimNextQueued("dev-1");

  expect(repo.runningDeviceIds()).toEqual(["dev-1"]);
  expect(repo.runningCount()).toBe(1);
});

test("hasActiveJob narrows to one device when given an id", () => {
  addDevice("dev-1");
  addDevice("dev-2");
  repo.createJob("donable", ["map/map"]);
  repo.claimNextQueued("dev-1");

  expect(repo.hasActiveJob("dev-1")).toBe(true);
  expect(repo.hasActiveJob("dev-2")).toBe(false);
  expect(repo.hasActiveJob()).toBe(true);
});

test("hasActiveJob(deviceId) ignores queued jobs, which belong to no device yet", () => {
  addDevice("dev-1");
  repo.createJob("donable", ["map/map"]);

  expect(repo.hasActiveJob("dev-1")).toBe(false);
  expect(repo.hasActiveJob()).toBe(true);
});

test("reconcileInterrupted fails running jobs but leaves queued ones queued", () => {
  addDevice("dev-1");
  const running = repo.createJob("donable", ["map/map"]);
  repo.claimNextQueued("dev-1");
  const waiting = repo.createJob("donable", ["donation/donation"]);

  expect(repo.reconcileInterrupted()).toBe(1);

  const closed = repo.getJob(running.id);
  expect(closed?.status).toBe("failed");
  expect(closed?.error).toBe("interrupted by restart");
  expect(closed?.deviceId).toBe("dev-1");
  expect(repo.getJob(waiting.id)?.status).toBe("queued");
});

test("failQueuedWithoutPayload closes queued jobs, leaves others alone, and reports the count", () => {
  addDevice("dev-1");
  const running = repo.createJob("donable", ["donation/donation"]);
  repo.claimNextQueued("dev-1");

  const queued = repo.createJob("donable", ["map/map"]);

  expect(repo.failQueuedWithoutPayload()).toBe(1);

  const closed = repo.getJob(queued.id);
  expect(closed?.status).toBe("failed");
  expect(closed?.error).toBe("interrupted by restart");
  expect(repo.getSteps(queued.id).every((s) => s.status === "skipped")).toBe(true);

  expect(repo.getJob(running.id)?.status).toBe("running");
  expect(repo.getSteps(running.id).some((s) => s.status === "queued")).toBe(true);
});

test("scheduler settings round-trip", () => {
  expect(repo.getSchedulerSettings()).toBeUndefined();
  repo.setSchedulerSettings({ maxConcurrentJobs: 2 });
  expect(repo.getSchedulerSettings()?.maxConcurrentJobs).toBe(2);
  repo.setSchedulerSettings({ maxConcurrentJobs: null });
  expect(repo.getSchedulerSettings()?.maxConcurrentJobs).toBeNull();
});
