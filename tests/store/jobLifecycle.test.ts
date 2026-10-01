import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";

let dir: string;
let db: Db;
let repo: JobRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-life-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("markJobRunning sets status and stamps startedAt once", () => {
  const job = repo.createJob("donable", ["map/map"]);
  repo.markJobRunning(job.id);

  const running = repo.getJob(job.id);
  expect(running?.status).toBe("running");
  expect(typeof running?.startedAt).toBe("number");
});

test("startStep marks exactly that step running and stamps startedAt", () => {
  const job = repo.createJob("donable", ["map/map"]);
  const step = repo.startStep(job.id, "device");

  expect(step.status).toBe("running");
  expect(typeof step.startedAt).toBe("number");
  expect(repo.getSteps(job.id).filter((s) => s.status === "running")).toHaveLength(1);
});

test("startStep targets exactly one row when a flow name is duplicated", () => {
  const job = repo.createJob("donable", ["a", "a"]);

  const first = repo.startStep(job.id, "a");
  repo.finishStep(first.id, { status: "passed", exitCode: 0 });

  // Only the first occurrence should have flipped to running/finished; the
  // second must still be queued, ready for its own startStep call.
  const steps = repo.getSteps(job.id);
  expect(steps.filter((s) => s.status === "running")).toHaveLength(0);
  expect(steps.filter((s) => s.status === "queued" && s.name === "a")).toHaveLength(1);

  const second = repo.startStep(job.id, "a");
  expect(second.id).not.toBe(first.id);
  expect(second.status).toBe("running");
});

test("startStep does not collide setup steps with same-named flows", () => {
  const job = repo.createJob("donable", ["device"]);

  const setupDevice = repo.startStep(job.id, "device");
  const stepsAfterSetup = repo.getSteps(job.id);
  // The flow named "device" (later ordinal) must remain untouched.
  const flowDevice = stepsAfterSetup.filter((s) => s.name === "device" && s.status === "queued");
  expect(flowDevice).toHaveLength(1);

  repo.finishStep(setupDevice.id, { status: "passed", exitCode: 0 });

  const flowStarted = repo.startStep(job.id, "device");
  expect(flowStarted.id).toBe(flowDevice[0].id);
  expect(flowStarted.status).toBe("running");
});

test("starting an already-started step throws", () => {
  const job = repo.createJob("donable", ["a"]);
  repo.startStep(job.id, "a");

  expect(() => repo.startStep(job.id, "a")).toThrow();
});

test("results are visible incrementally, not only when the job ends", () => {
  const job = repo.createJob("donable", ["a", "b", "c"]);
  repo.markJobRunning(job.id);

  const first = repo.startStep(job.id, "a");
  repo.finishStep(first.id, { status: "passed", exitCode: 0 });

  // The whole point of this work: a caller polling mid-run sees progress.
  const steps = repo.getSteps(job.id);
  expect(steps.find((s) => s.name === "a")?.status).toBe("passed");
  expect(steps.find((s) => s.name === "b")?.status).toBe("queued");
  expect(repo.getJob(job.id)?.status).toBe("running");
});

test("finishStep records exit code, previews, artifact dir and warnings", () => {
  const job = repo.createJob("donable", ["a"]);
  const step = repo.startStep(job.id, "a", "/tmp/x/e2e/scenarios/a.yaml");

  const done = repo.finishStep(step.id, {
    status: "failed",
    exitCode: 1,
    warnings: ["clear app data failed (exit 1)"],
    artifactDir: "job-1/3",
    stdoutPreview: "out",
    stderrPreview: "boom",
  });

  expect(done.status).toBe("failed");
  expect(done.exitCode).toBe(1);
  expect(done.warnings).toEqual(["clear app data failed (exit 1)"]);
  expect(done.artifactDir).toBe("job-1/3");
  expect(done.resolvedPath).toBe("/tmp/x/e2e/scenarios/a.yaml");
  expect(typeof done.finishedAt).toBe("number");
});

test("previews are truncated so the database stays small", () => {
  const job = repo.createJob("donable", ["a"]);
  const step = repo.startStep(job.id, "a");

  const done = repo.finishStep(step.id, { status: "passed", stdoutPreview: "x".repeat(10_000) });

  expect(done.stdoutPreview!.length).toBeLessThanOrEqual(2100);
  expect(done.stdoutPreview).toContain("truncated");
});

test("skipRemainingSteps marks everything still queued as skipped", () => {
  const job = repo.createJob("donable", ["a", "b"]);
  const step = repo.startStep(job.id, "device");
  repo.finishStep(step.id, { status: "failed", exitCode: 1 });
  repo.skipRemainingSteps(job.id);

  const steps = repo.getSteps(job.id);
  expect(steps.filter((s) => s.status === "skipped")).toHaveLength(4);
  expect(steps.find((s) => s.name === "device")?.status).toBe("failed");
});

test("finishJob stamps status, error and finishedAt", () => {
  const job = repo.createJob("donable", ["a"]);
  repo.markJobRunning(job.id);
  repo.finishJob(job.id, "failed", "disk exploded");

  const done = repo.getJob(job.id);
  expect(done?.status).toBe("failed");
  expect(done?.error).toBe("disk exploded");
  expect(typeof done?.finishedAt).toBe("number");
});

test("reconcileInterrupted closes jobs the deploy restart abandoned", () => {
  // The update timer restarts this service on every merge to main. Without
  // reconciliation those rows read "running" forever.
  const abandoned = repo.createJob("donable", ["a"]);
  repo.markJobRunning(abandoned.id);
  repo.startStep(abandoned.id, "device");

  const closed = new JobRepository(db).reconcileInterrupted();

  expect(closed).toBe(1);
  const job = repo.getJob(abandoned.id);
  expect(job?.status).toBe("failed");
  expect(job?.error).toBe("interrupted by restart");
  expect(repo.getSteps(abandoned.id).find((s) => s.name === "device")?.status).toBe("failed");
});

test("reconcileInterrupted leaves jobs left queued by a restart alone", () => {
  // The queue is now the jobs table itself: a job still queued when the
  // process died survives the restart and gets picked up by dispatch(), so
  // closing it here would throw away work the farm can still do.
  const queued = repo.createJob("donable", ["a"]);

  expect(new JobRepository(db).reconcileInterrupted()).toBe(0);
  expect(repo.getJob(queued.id)?.status).toBe("queued");
  expect(repo.getSteps(queued.id).every((s) => s.status === "queued")).toBe(true);
});

test("reconcileInterrupted is a no-op on a clean database", () => {
  expect(repo.reconcileInterrupted()).toBe(0);
});

test("artifacts are recorded against a step and totalled for the ops panel", () => {
  const job = repo.createJob("donable", ["a"]);
  const step = repo.startStep(job.id, "a");

  repo.recordArtifacts(step.id, [
    { kind: "screenshot", relPath: `${job.id}/3/shot.png`, bytes: 1024 },
    { kind: "stdout", relPath: `${job.id}/3/stdout.log`, bytes: 12 },
  ]);

  expect(repo.getArtifacts(step.id)).toHaveLength(2);
  expect(repo.totalArtifactBytes()).toBe(1036);

  const [first] = repo.getArtifacts(step.id);
  expect(repo.getArtifact(first.id)?.relPath).toBe(`${job.id}/3/shot.png`);
});

test("deleting a job removes its artifacts too", () => {
  const job = repo.createJob("donable", ["a"]);
  const step = repo.startStep(job.id, "a");
  repo.recordArtifacts(step.id, [{ kind: "stdout", relPath: "x", bytes: 1 }]);

  db.run("DELETE FROM jobs WHERE id = ?", job.id);

  expect(repo.totalArtifactBytes()).toBe(0);
});
