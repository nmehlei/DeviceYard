// tests/retention.test.ts
import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, type Db } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { JobRepository } from "../src/store/jobRepository";
import { evaluateRetention, runRetentionSweep } from "../src/retention";
import type { EvictableJobRow } from "../src/store/rows";

describe("evaluateRetention (pure)", () => {
  const jobs: EvictableJobRow[] = [
    { id: "old", createdAt: 1000, bytes: 100 },
    { id: "mid", createdAt: 2000, bytes: 300 },
    { id: "new", createdAt: 3000, bytes: 600 },
  ];
  const now = 3000;

  test("with every threshold disabled, nothing is evicted", () => {
    expect(evaluateRetention(jobs, { maxAgeDays: null, maxTotalBytes: null, maxJobs: null }, now)).toEqual([]);
  });

  test("maxAgeDays evicts jobs older than the cutoff", () => {
    const oneDayMs = 24 * 60 * 60 * 1000;
    const result = evaluateRetention(
      jobs,
      { maxAgeDays: 1, maxTotalBytes: null, maxJobs: null },
      1000 + oneDayMs + 500 // "old" (created at 1000) is just past 1 day old; "mid"/"new" are not
    );
    expect(result).toEqual(["old"]);
  });

  test("maxJobs evicts everything past the most recent N", () => {
    expect(evaluateRetention(jobs, { maxAgeDays: null, maxTotalBytes: null, maxJobs: 1 }, now)).toEqual([
      "old",
      "mid",
    ]);
  });

  test("maxJobs is a no-op when the job count is already within budget", () => {
    expect(evaluateRetention(jobs, { maxAgeDays: null, maxTotalBytes: null, maxJobs: 10 }, now)).toEqual([]);
  });

  test("maxTotalBytes evicts oldest-first until under budget", () => {
    // total = 1000; evicting "old" (100) leaves 900, still over 700; evicting
    // "mid" (300) too leaves 600, under 700 - stop there, "new" survives.
    expect(evaluateRetention(jobs, { maxAgeDays: null, maxTotalBytes: 700, maxJobs: null }, now)).toEqual([
      "old",
      "mid",
    ]);
  });

  test("thresholds combine as a union, not independently overwriting each other", () => {
    const result = evaluateRetention(jobs, { maxAgeDays: null, maxTotalBytes: null, maxJobs: 2 }, now);
    // maxJobs=2 evicts only "old" on its own...
    expect(result).toEqual(["old"]);
  });
});

describe("runRetentionSweep (I/O)", () => {
  let dir: string;
  let dataDir: string;
  let db: Db;
  let repo: JobRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-retention-"));
    dataDir = path.join(dir, "data");
    db = openDatabase(path.join(dataDir, "farm.db"));
    migrate(db);
    repo = new JobRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("with no settings saved, the sweep evicts nothing", async () => {
    const job = repo.createJob("donable", ["a"]);
    repo.markJobRunning(job.id);
    repo.finishJob(job.id, "done");

    const result = await runRetentionSweep(repo, dataDir);

    expect(result.evicted).toBe(0);
    expect(repo.getJob(job.id)).toBeDefined();
  });

  test("evicts a job's artifact directory from disk and its row from the database", async () => {
    const job = repo.createJob("donable", ["a"]);
    repo.markJobRunning(job.id);
    repo.finishJob(job.id, "done");
    const artifactDir = path.join(dataDir, "artifacts", job.id, "3");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "recording.mp4"), "bytes");

    repo.setRetentionSettings({ maxAgeDays: null, maxTotalBytes: null, maxJobs: 0 });
    const result = await runRetentionSweep(repo, dataDir);

    expect(result.evicted).toBe(1);
    expect(repo.getJob(job.id)).toBeUndefined();
    expect(fs.existsSync(path.join(dataDir, "artifacts", job.id))).toBe(false);
  });

  test("never evicts a queued or running job regardless of settings", async () => {
    const job = repo.createJob("donable", ["a"]);
    repo.markJobRunning(job.id);
    repo.setRetentionSettings({ maxAgeDays: 0, maxTotalBytes: null, maxJobs: 0 });

    const result = await runRetentionSweep(repo, dataDir);

    expect(result.evicted).toBe(0);
    expect(repo.getJob(job.id)).toBeDefined();
  });
});
