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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-oldest-queued-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addDevice(id: string): void {
  db.run("INSERT INTO devices (id, label, model, is_active, added_at) VALUES (?, ?, NULL, 1, 1)", id, id);
}

test("is undefined with nothing queued", () => {
  expect(repo.oldestQueuedJobId()).toBeUndefined();
});

test("returns the job the scheduler would claim next", () => {
  const first = repo.createJob("org", ["a"]);
  repo.createJob("org", ["b"]);
  expect(repo.oldestQueuedJobId()).toBe(first.id);
});

test("ignores jobs that are no longer queued", () => {
  addDevice("dev-1");
  const first = repo.createJob("org", ["a"]);
  const second = repo.createJob("org", ["b"]);
  repo.claimNextQueued("dev-1");
  expect(repo.oldestQueuedJobId()).toBe(second.id);
  expect(first.id).not.toBe(second.id);
});
