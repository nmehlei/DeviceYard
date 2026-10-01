import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { REDACTED } from "../../src/env";

let dir: string;
let repo: JobRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-env-"));
  const db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("createJob with env", () => {
  it("stores nothing when no env is supplied - absent stays absent", () => {
    const job = repo.createJob("donable", ["map"]);
    expect(repo.getJob(job.id)!.envJson).toBeNull();
  });

  it("distinguishes an explicitly empty env from an absent one", () => {
    const job = repo.createJob("momentum", ["map"], {});
    expect(repo.getJob(job.id)!.envJson).toBe("{}");
  });

  it("keeps non-secret values and redacts secret ones", () => {
    const job = repo.createJob("momentum", ["map"], {
      E2E_LAUNCHER: "samsung",
      E2E_TEST_PASSWORD: "hunter2222",
    });
    const stored = JSON.parse(repo.getJob(job.id)!.envJson!);
    expect(stored.E2E_LAUNCHER).toBe("samsung");
    expect(stored.E2E_TEST_PASSWORD).toBe(REDACTED);
  });

  it("never writes a secret value into the database", () => {
    const job = repo.createJob("momentum", ["map"], { API_KEY: "sk-supersecret" });
    expect(repo.getJob(job.id)!.envJson).not.toContain("sk-supersecret");
  });
});
