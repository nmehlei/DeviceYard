import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import express from "express";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { fileRoutes } from "../../src/api/files";

let dir: string;
let db: Db;
let repo: JobRepository;

function app() {
  const a = express();
  a.use((req, _res, next) => {
    req.org = "donable";
    next();
  });
  a.use(fileRoutes({ repo, dataDir: dir }));
  return a;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-files-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function withArtifact(kind: "stdout" | "screenshot", content: string, org = "donable") {
  const job = repo.createJob(org, ["a"]);
  const step = repo.startStep(job.id, "a");
  const name = kind === "stdout" ? "stdout.log" : "shot.png";
  const relPath = path.join(job.id, "3", name);
  fs.mkdirSync(path.join(dir, "artifacts", job.id, "3"), { recursive: true });
  fs.writeFileSync(path.join(dir, "artifacts", relPath), content);
  repo.recordArtifacts(step.id, [{ kind, relPath, bytes: content.length }]);
  return { job, step, artifact: repo.getArtifacts(step.id)[0] };
}

test("a flow's log is served as plain text", async () => {
  const { step } = withArtifact("stdout", "line one\nline two\n");

  const res = await request(app()).get(`/api/flow-runs/${step.id}/log?stream=stdout`);

  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("text/plain");
  expect(res.text).toContain("line two");
});

test("a missing log is a 404, not a 500", async () => {
  const res = await request(app()).get("/api/flow-runs/999/log?stream=stdout");
  expect(res.status).toBe(404);
});

test("an artifact is served by id", async () => {
  const { artifact } = withArtifact("screenshot", "png-bytes");

  const res = await request(app()).get(`/api/artifacts/${artifact.id}`);

  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("image/png");
});

// Ownership must be proven by the foreign key chain (flow_runs.job_id ->
// jobs.org), not inferred from the shape of relPath, so these use a real
// job/step/artifact for "other" with a correctly-formed relPath - a naive
// path-prefix check on a malformed relPath would 404 either way and prove
// nothing about whether the actual org check works.
test("another org's artifact is a 404", async () => {
  const { artifact } = withArtifact("screenshot", "png-bytes", "other");

  const res = await request(app()).get(`/api/artifacts/${artifact.id}`);
  expect(res.status).toBe(404);
});

test("another org's log is a 404", async () => {
  const { step } = withArtifact("stdout", "line one\nline two\n", "other");

  const res = await request(app()).get(`/api/flow-runs/${step.id}/log?stream=stdout`);
  expect(res.status).toBe(404);
});

test("an artifact request without a Range header gets a full 200 response", async () => {
  const { artifact } = withArtifact("screenshot", "0123456789");

  const res = await request(app()).get(`/api/artifacts/${artifact.id}`);

  expect(res.status).toBe(200);
  expect(res.headers["accept-ranges"]).toBe("bytes");
  expect(res.headers["content-length"]).toBe("10");
  expect(res.body.toString("utf8")).toBe("0123456789");
});

test("an artifact request with a Range header gets a 206 partial response", async () => {
  const { artifact } = withArtifact("screenshot", "0123456789");

  const res = await request(app())
    .get(`/api/artifacts/${artifact.id}`)
    .set("Range", "bytes=2-4");

  expect(res.status).toBe(206);
  expect(res.headers["content-range"]).toBe("bytes 2-4/10");
  expect(res.headers["accept-ranges"]).toBe("bytes");
  expect(res.headers["content-length"]).toBe("3");
  expect(res.body.toString("utf8")).toBe("234");
});

test("an artifact request with an open-ended Range header gets everything from the start offset", async () => {
  const { artifact } = withArtifact("screenshot", "0123456789");

  const res = await request(app())
    .get(`/api/artifacts/${artifact.id}`)
    .set("Range", "bytes=7-");

  expect(res.status).toBe(206);
  expect(res.headers["content-range"]).toBe("bytes 7-9/10");
  expect(res.headers["content-length"]).toBe("3");
  expect(res.body.toString("utf8")).toBe("789");
});

test("an artifact request with an out-of-bounds Range header is a 416, not a crash", async () => {
  const { artifact } = withArtifact("screenshot", "0123456789");

  const res = await request(app())
    .get(`/api/artifacts/${artifact.id}`)
    .set("Range", "bytes=100-200");

  expect(res.status).toBe(416);
  expect(res.headers["content-range"]).toBe("bytes */10");
});

test("a zero-byte artifact is an empty 200, not a 500", async () => {
  // An empty stderr.log is routine, and the Range support added for video
  // playback computed `end = size - 1 = -1` for it, which makes
  // fs.createReadStream throw synchronously.
  const { artifact } = withArtifact("stdout", "");

  const res = await request(app()).get(`/api/artifacts/${artifact.id}`);

  expect(res.status).toBe(200);
  expect(res.headers["content-length"]).toBe("0");
});

test("a Range request against a zero-byte artifact is a 416, not a crash", async () => {
  const { artifact } = withArtifact("stdout", "");

  const res = await request(app())
    .get(`/api/artifacts/${artifact.id}`)
    .set("Range", "bytes=0-0");

  expect(res.status).toBe(416);
  expect(res.headers["content-range"]).toBe("bytes */0");
});

test("a stored path escaping the artifact root is refused", async () => {
  const job = repo.createJob("donable", ["a"]);
  const step = repo.startStep(job.id, "a");
  repo.recordArtifacts(step.id, [{ kind: "stdout", relPath: "../../../etc/passwd", bytes: 1 }]);
  const artifact = repo.getArtifacts(step.id)[0];

  const res = await request(app()).get(`/api/artifacts/${artifact.id}`);
  expect(res.status).toBe(404);
});
