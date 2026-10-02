import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { DEFAULT_MAX_UPLOAD_BYTES, JobRepository } from "../../src/store/jobRepository";

let dir: string;
let repo: JobRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-settings-"));
  const db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the three-state upload limit rule", () => {
  test("a database nobody has configured enforces the default, not unlimited", () => {
    expect(repo.getUploadSettings()).toBeUndefined();
    expect(repo.effectiveUploadLimit()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });

  test("a stored integer is enforced as-is", () => {
    repo.setUploadSettings({ maxUploadBytes: 1024 });
    expect(repo.effectiveUploadLimit()).toBe(1024);
  });

  test("a row storing null means the admin chose no limit", () => {
    repo.setUploadSettings({ maxUploadBytes: null });
    // Distinct from the never-configured case above, which returns the
    // default: the difference is carried by the row existing, not by the
    // column's value. Getting this backwards would silently un-limit every
    // fresh deployment.
    expect(repo.getUploadSettings()).toEqual({ maxUploadBytes: null, updatedAt: expect.any(Number) });
    expect(repo.effectiveUploadLimit()).toBeNull();
  });

  test("clearing a previously set limit switches to unlimited, not back to the default", () => {
    repo.setUploadSettings({ maxUploadBytes: 1024 });
    repo.setUploadSettings({ maxUploadBytes: null });
    expect(repo.effectiveUploadLimit()).toBeNull();
  });
});

describe("setUploadSettings", () => {
  test("upserts the singleton rather than accumulating rows", () => {
    repo.setUploadSettings({ maxUploadBytes: 1 });
    repo.setUploadSettings({ maxUploadBytes: 2 });
    repo.setUploadSettings({ maxUploadBytes: 3 });
    expect(repo.effectiveUploadLimit()).toBe(3);
  });

  test("returns the row it saved", () => {
    const saved = repo.setUploadSettings({ maxUploadBytes: 4096 });
    expect(saved.maxUploadBytes).toBe(4096);
    expect(saved.updatedAt).toEqual(expect.any(Number));
  });
});

test("the default is 512 MB", () => {
  expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(512 * 1024 * 1024);
});
