import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import request from "supertest";
import { createServer } from "../../src/server";
import { defaultRunner, type CommandRunner } from "../../src/maestro";
import { openDatabase } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { OrgTokenRepository } from "../../src/store/orgTokenRepository";
import { UserTokenRepository } from "../../src/store/userTokenRepository";

function makeRepo(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(path.join(dataDir, "farm.db"));
  migrate(db);
  const deviceRepo = new DeviceRepository(db);
  deviceRepo.seedIfEmpty(DEVICE);

  const userRepo = new UserRepository(db);
  const orgRepo = new OrgRepository(db);
  const orgTokenRepo = new OrgTokenRepository(db, TOKEN_ENCRYPTION_KEY);
  const userTokenRepo = new UserTokenRepository(db, TOKEN_ENCRYPTION_KEY);
  const admin = userRepo.create({ username: "admin", email: "admin@example.com", password: "x", isAdmin: true });
  for (const [org, token] of Object.entries(TOKENS)) {
    const created = orgRepo.create(org, [admin.id]);
    orgTokenRepo.create(created.id, "test", token, admin.id);
  }

  return { repo: new JobRepository(db), deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo };
}

// Pins the response shapes DonableApp's pipeline depends on. If a change to
// storage or the job pipeline alters anything asserted here, CI breaks in
// production - that is the whole point of this file.

const TOKENS = { donable: "donable-token-123", other: "other-token-456" };
const DEVICE = "emulator-5554";
const APP_ID = "net.donable.app.testing";
const FLOW = "map/map";
const TOKEN_ENCRYPTION_KEY = "0".repeat(64);

function runner(): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

let uploadDir: string;
let apkPath: string;
let archivePath: string;
let dataDir: string;
let repo: JobRepository;
let deviceRepo: DeviceRepository;
let userRepo: UserRepository;
let orgRepo: OrgRepository;
let orgTokenRepo: OrgTokenRepository;
let userTokenRepo: UserTokenRepository;

beforeAll(() => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-contract-src-"));
  const scenarios = path.join(srcDir, "e2e", "scenarios", "map");
  fs.mkdirSync(scenarios, { recursive: true });
  fs.writeFileSync(path.join(scenarios, "map.yaml"), "appId: test\n---\n- launchApp\n");
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-contract-arc-"));
  archivePath = path.join(archiveDir, "flows.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", srcDir, "e2e"]);
});

beforeEach(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-contract-up-"));
  apkPath = path.join(uploadDir, "app.apk");
  fs.writeFileSync(apkPath, "not-a-real-apk");
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-contract-data-"));
  ({ repo, deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo } = makeRepo(dataDir));
});

function server() {
  return createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo,
    sessionSecret: "test-session-secret",
    deviceId: DEVICE,
    deviceRepo,
    resolveAppId: async () => ({ appId: APP_ID, appVersion: null }),
    uploadDir,
    runner: runner(),
    repo,
    dataDir,
  });
}

async function submit(app: ReturnType<typeof createServer>) {
  return request(app)
    .post("/run")
    .set("Authorization", `Bearer ${TOKENS.donable}`)
    .field("flows", JSON.stringify([FLOW]))
    .attach("apk", apkPath)
    .attach("flowsArchive", archivePath);
}

// See tests/server.test.ts's waitForDone for why this budget is large: a job
// now does real filesystem and database work, and jest runs suites in
// parallel workers, so a tight polling budget flakes under load rather than
// reflecting anything about correctness. This does not change what is
// asserted (still: the job reaches a terminal status), only how long the
// test is willing to wait for that inherently asynchronous event.
const TERMINAL_POLL_ATTEMPTS = 500;
const TERMINAL_POLL_INTERVAL_MS = 10;

async function waitForTerminal(app: ReturnType<typeof createServer>, id: string) {
  for (let i = 0; i < TERMINAL_POLL_ATTEMPTS; i++) {
    const res = await request(app).get(`/run/${id}`).set("Authorization", `Bearer ${TOKENS.donable}`);
    if (res.body.status === "done" || res.body.status === "failed") return res.body;
    await new Promise((r) => setTimeout(r, TERMINAL_POLL_INTERVAL_MS));
  }
  throw new Error("job never reached a terminal status");
}

test("POST /run returns 202 with exactly {id, status}", async () => {
  const app = server();
  const res = await submit(app);

  expect(res.status).toBe(202);
  expect(Object.keys(res.body).sort()).toEqual(["id", "status"]);
  expect(res.body.status).toBe("queued");
  expect(typeof res.body.id).toBe("string");

  await waitForTerminal(app, res.body.id);
});

test("GET /run/:id on a finished job carries the exact documented keys", async () => {
  const app = server();
  const { body } = await submit(app);
  const job = await waitForTerminal(app, body.id);

  expect(Object.keys(job).sort()).toEqual(
    ["createdAt", "flows", "id", "org", "results", "status"].sort()
  );
  expect(job.org).toBe("donable");
  expect(job.flows).toEqual([FLOW]);
  expect(job.status).toBe("done");
  expect(typeof job.createdAt).toBe("number");
});

test("each result carries flow, passed, stdout, stderr - and flow is the resolved yaml path", async () => {
  const app = server();
  const { body } = await submit(app);
  const job = await waitForTerminal(app, body.id);

  expect(job.results).toHaveLength(1);
  const [result] = job.results;
  expect(Object.keys(result).sort()).toEqual(["flow", "passed", "stderr", "stdout"]);
  expect(result.passed).toBe(true);
  expect(result.flow).toContain(path.join("e2e", "scenarios", "map", "map.yaml"));
  expect(typeof result.stdout).toBe("string");
  expect(typeof result.stderr).toBe("string");
});

test("GET /jobs returns an array of jobs for the caller's org only", async () => {
  const app = server();
  const { body } = await submit(app);
  await waitForTerminal(app, body.id);

  const mine = await request(app).get("/jobs").set("Authorization", `Bearer ${TOKENS.donable}`);
  expect(mine.status).toBe(200);
  expect(Array.isArray(mine.body)).toBe(true);
  expect(mine.body).toHaveLength(1);

  const theirs = await request(app).get("/jobs").set("Authorization", `Bearer ${TOKENS.other}`);
  expect(theirs.body).toEqual([]);
});

test("another org gets 404, not 403, for a job it does not own", async () => {
  const app = server();
  const { body } = await submit(app);

  const res = await request(app).get(`/run/${body.id}`).set("Authorization", `Bearer ${TOKENS.other}`);
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: "job not found" });

  await waitForTerminal(app, body.id);
});

test("auth failures keep their exact codes and bodies", async () => {
  const app = server();

  const missing = await request(app).get("/jobs");
  expect(missing.status).toBe(401);
  expect(missing.body).toEqual({ error: "missing bearer token" });

  const bad = await request(app).get("/jobs").set("Authorization", "Bearer nope");
  expect(bad.status).toBe(403);
  expect(bad.body).toEqual({ error: "invalid token" });
});

test("validation failures keep their exact codes and bodies", async () => {
  const app = server();

  const noApk = await request(app)
    .post("/run")
    .set("Authorization", `Bearer ${TOKENS.donable}`)
    .field("flows", JSON.stringify([FLOW]))
    .attach("flowsArchive", archivePath);
  expect(noApk.status).toBe(400);
  expect(noApk.body).toEqual({ error: "apk file is required" });

  const badFlows = await request(app)
    .post("/run")
    .set("Authorization", `Bearer ${TOKENS.donable}`)
    .field("flows", "not-json")
    .attach("apk", apkPath)
    .attach("flowsArchive", archivePath);
  expect(badFlows.status).toBe(400);
  expect(badFlows.body).toEqual({ error: "flows must be a non-empty JSON array of strings" });
});

test("a device that is not ready is reported as a done job with a <device> result", async () => {
  const missingDevice: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
    if (args.includes("devices")) {
      return { code: 0, stdout: "List of devices attached\n", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo,
    sessionSecret: "test-session-secret",
    deviceId: DEVICE,
    deviceRepo,
    resolveAppId: async () => ({ appId: APP_ID, appVersion: null }),
    uploadDir,
    runner: missingDevice,
    repo,
    dataDir,
  });

  const { body } = await submit(app);
  const job = await waitForTerminal(app, body.id);

  expect(job.status).toBe("done");
  expect(job.results).toHaveLength(1);
  expect(job.results[0].flow).toBe("<device>");
  expect(job.results[0].passed).toBe(false);
  expect(job.results[0].stderr).toContain("not present in `adb devices`");
});

test("a job queued when the process restarts still reaches a terminal status", async () => {
  // The behaviour DonableApp's pipeline depends on: whatever the queue does
  // internally, a submitted job never sits queued forever - CI polls until
  // its own timeout and falls back to a paid device cloud, which is the cost
  // this farm exists to avoid. Cycle 10 changed the mechanism (a durable
  // queue) without changing this guarantee.
  const app = server();
  const job = repo.createJob("donable", ["a"]);
  repo.failQueuedWithoutPayload();

  const res = await request(app).get(`/run/${job.id}`).set("Authorization", `Bearer ${TOKENS.donable}`);
  expect(res.body.status).toBe("failed");
  expect(res.body.error).toBe("interrupted by restart");
  expect(res.body).not.toHaveProperty("deviceId");
});
