import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import request from "supertest";
import { createServer } from "../src/server";
import { openDatabase } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { JobRepository } from "../src/store/jobRepository";
import { DeviceRepository } from "../src/store/deviceRepository";
import { UserRepository } from "../src/store/userRepository";
import { OrgRepository } from "../src/store/orgRepository";
import { OrgTokenRepository } from "../src/store/orgTokenRepository";
import { UserTokenRepository } from "../src/store/userTokenRepository";

// What POST /run does now: persist the job, hand it to the scheduler, answer
// 202. The scheduler is a spy here - this file is about the HANDOVER, not
// about dispatch, which tests/scheduler.test.ts covers with no HTTP in the
// way. The spy is also what keeps these tests from touching adb: nothing is
// ever actually claimed or started.

const TOKEN_ENCRYPTION_KEY = "2".repeat(64);
const TOKEN = "dispatch-token";
const TEST_DEVICE_ID = "emulator-5554";
const APP_ID = "net.donable.app.testing";
const FLOW_NAME = "map/map";

function makeDeps(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(path.join(dataDir, "farm.db"));
  migrate(db);
  const deviceRepo = new DeviceRepository(db);
  deviceRepo.seedIfEmpty(TEST_DEVICE_ID);

  const userRepo = new UserRepository(db);
  const orgRepo = new OrgRepository(db);
  const orgTokenRepo = new OrgTokenRepository(db, TOKEN_ENCRYPTION_KEY);
  const userTokenRepo = new UserTokenRepository(db, TOKEN_ENCRYPTION_KEY);
  const admin = userRepo.create({ username: "admin", email: "admin@example.com", password: "x", isAdmin: true });
  const org = orgRepo.create("dispatch-org", [admin.id]);
  orgTokenRepo.create(org.id, "test", TOKEN, admin.id);

  return { repo: new JobRepository(db), deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo };
}

let uploadDir: string;
let apkPath: string;
let flowsArchivePath: string;
let dataDir: string;

beforeAll(() => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-dispatch-fixture-src-"));
  const scenariosDir = path.join(srcDir, "e2e", "scenarios", "map");
  fs.mkdirSync(scenariosDir, { recursive: true });
  fs.writeFileSync(path.join(scenariosDir, "map.yaml"), "appId: test\n---\n- launchApp\n");

  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-dispatch-fixture-archive-"));
  flowsArchivePath = path.join(archiveDir, "flows.tar.gz");
  execFileSync("tar", ["-czf", flowsArchivePath, "-C", srcDir, "e2e"]);
});

beforeEach(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-dispatch-upload-"));
  apkPath = path.join(os.tmpdir(), `dispatch-fixture-${Date.now()}-${Math.random()}.apk`);
  fs.writeFileSync(apkPath, Buffer.from("fake apk bytes"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-dispatch-data-"));
});

afterEach(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.rmSync(apkPath, { force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function submit(app: ReturnType<typeof createServer>) {
  return request(app)
    .post("/run")
    .set("Authorization", `Bearer ${TOKEN}`)
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
}

// Same generous budget as the sibling server suites: the first test in a
// fresh worker pays for migrations, well past jest's 5s default.
const TEST_TIMEOUT_MS = 20000;

test("POST /run persists the job as queued and submits it to the scheduler", async () => {
  const deps = makeDeps(dataDir);
  const submitted: string[] = [];
  const app = createServer({
    ...deps,
    sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID,
    uploadDir,
    dataDir,
    resolveAppId: async () => ({ appId: APP_ID, appVersion: null }),
    scheduler: { submit: (id: string) => void submitted.push(id) },
  });

  const res = await submit(app);

  expect(res.status).toBe(202);
  expect(res.body).toEqual({ id: expect.any(String), status: "queued" });
  expect(submitted).toEqual([res.body.id]);
  expect(deps.repo.getJob(res.body.id)?.status).toBe("queued");
}, TEST_TIMEOUT_MS);

test("POST /run 503s when the pool is empty", async () => {
  const deps = makeDeps(dataDir);
  // seedIfEmpty enrolled one device; drain it so the pool is genuinely empty.
  deps.deviceRepo.disable(TEST_DEVICE_ID);

  const app = createServer({
    ...deps,
    sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID,
    uploadDir,
    dataDir,
    resolveAppId: async () => ({ appId: APP_ID, appVersion: null }),
    scheduler: { submit: () => undefined },
  });

  const res = await submit(app);

  expect(res.status).toBe(503);
  expect(res.body.error).toMatch(/no device is enrolled/);
  // A rejected request must not leave its uploads behind.
  expect(fs.readdirSync(uploadDir)).toHaveLength(0);
}, TEST_TIMEOUT_MS);

test("POST /run queues rather than 503s when every enrolled device is busy", async () => {
  const deps = makeDeps(dataDir);
  // Occupy the only device with a running job, the exact state the old
  // single-device handler had no way to express other than serialising
  // behind it. A busy pool must still accept work.
  const blocking = deps.repo.createJob("dispatch-org", [FLOW_NAME]);
  expect(deps.repo.claimNextQueued(TEST_DEVICE_ID)?.id).toBe(blocking.id);

  const submitted: string[] = [];
  const app = createServer({
    ...deps,
    sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID,
    uploadDir,
    dataDir,
    resolveAppId: async () => ({ appId: APP_ID, appVersion: null }),
    scheduler: { submit: (id: string) => void submitted.push(id) },
  });

  const res = await submit(app);

  expect(res.status).toBe(202);
  expect(res.body.status).toBe("queued");
  expect(submitted).toEqual([res.body.id]);
}, TEST_TIMEOUT_MS);

test("POST /run still 202s and leaves the job queued when the scheduler's initial submit throws", async () => {
  const deps = makeDeps(dataDir);
  const app = createServer({
    ...deps,
    sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID,
    uploadDir,
    dataDir,
    resolveAppId: async () => ({ appId: APP_ID, appVersion: null }),
    scheduler: {
      submit: () => {
        throw new Error("boom");
      },
    },
  });

  const res = await submit(app);

  // The job was already persisted before submit() ran; a dispatch failure
  // must not turn into a 500 for work the caller was already told is queued.
  // The safety tick is what recovers it.
  expect(res.status).toBe(202);
  expect(res.body).toEqual({ id: expect.any(String), status: "queued" });
  expect(deps.repo.getJob(res.body.id)?.status).toBe("queued");
}, TEST_TIMEOUT_MS);

test("a resolved appVersion is persisted on the created job", async () => {
  const deps = makeDeps(dataDir);
  const submitted: string[] = [];
  const app = createServer({
    ...deps,
    sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID,
    uploadDir,
    dataDir,
    resolveAppId: async () => ({ appId: "com.example.app", appVersion: "2.4.1 (240)" }),
    scheduler: { submit: (id: string) => void submitted.push(id) },
  });

  const res = await submit(app);

  expect(res.status).toBe(202);
  const job = deps.repo.getJob(res.body.id);
  expect(job?.appId).toBe("com.example.app");
  expect(job?.appVersion).toBe("2.4.1 (240)");
}, TEST_TIMEOUT_MS);
