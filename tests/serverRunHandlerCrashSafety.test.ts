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

// Regression coverage for: converting the POST /run handler to `async` (to
// await app-id resolution from the uploaded apk) changes what happens when a
// *pre-existing, unrelated* synchronous call in the same handler throws -
// e.g. deviceRepo.listEnrolled() or repo.createJob() hitting a transient
// storage error. Express 4 only turns a throw into a clean response for a
// *synchronous* handler; once the handler is async, an uncaught throw
// becomes a promise rejection nothing awaits or .catches, which - with no
// express-async-errors/error middleware/unhandledRejection handler anywhere
// in this project - would hang the request and risk taking the whole
// process down. Without the handler's top-level try/catch, every test below
// would time out instead of asserting a clean 500.

const TOKEN_ENCRYPTION_KEY = "1".repeat(64);
const TOKEN = "crash-safety-token";
const TEST_DEVICE_ID = "emulator-5554";
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
  const org = orgRepo.create("crash-safety-org", [admin.id]);
  orgTokenRepo.create(org.id, "test", TOKEN, admin.id);

  return { repo: new JobRepository(db), deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo };
}

let uploadDir: string;
let apkPath: string;
let flowsArchivePath: string;
let dataDir: string;

beforeAll(() => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-crash-fixture-src-"));
  const scenariosDir = path.join(srcDir, "e2e", "scenarios", "map");
  fs.mkdirSync(scenariosDir, { recursive: true });
  fs.writeFileSync(path.join(scenariosDir, "map.yaml"), "appId: test\n---\n- launchApp\n");

  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-crash-fixture-archive-"));
  flowsArchivePath = path.join(archiveDir, "flows.tar.gz");
  execFileSync("tar", ["-czf", flowsArchivePath, "-C", srcDir, "e2e"]);
});

beforeEach(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-crash-upload-"));
  apkPath = path.join(os.tmpdir(), `crash-fixture-${Date.now()}-${Math.random()}.apk`);
  fs.writeFileSync(apkPath, Buffer.from("fake apk bytes"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-crash-data-"));
});

afterEach(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.rmSync(apkPath, { force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

// Generous per-test timeout, not because this scenario is expected to be
// slow - db/migration setup for the first test in a fresh jest worker
// measured ~6s here, well past jest's 5s default, while the second test
// (same work, warm worker) took under 1s. This isn't a proxy for "did the
// fix work": an actual regression (the pre-fix behavior) hangs indefinitely,
// so any finite timeout still distinguishes fixed from broken.
const TEST_TIMEOUT_MS = 20000;

test("a synchronous throw from deviceRepo.listEnrolled() still yields a clean 500, not a hung/crashed request", async () => {
  const { repo, deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo } = makeDeps(dataDir);
  jest.spyOn(deviceRepo, "listEnrolled").mockImplementation(() => {
    throw new Error("simulated transient storage error");
  });

  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID, deviceRepo, uploadDir, repo, dataDir,
  });

  const res = await request(app)
    .post("/run")
    .set("Authorization", `Bearer ${TOKEN}`)
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);

  expect(res.status).toBe(500);
  // The pre-existing per-path cleanup contract still holds for this
  // catch-all: an upload that never made it into a job must not linger.
  expect(fs.readdirSync(uploadDir)).toHaveLength(0);
}, TEST_TIMEOUT_MS);

test("a synchronous throw from repo.createJob() still yields a clean 500, not a hung/crashed request", async () => {
  const { repo, deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo } = makeDeps(dataDir);
  jest.spyOn(repo, "createJob").mockImplementation(() => {
    throw new Error("simulated transient storage error");
  });

  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID, deviceRepo, uploadDir, repo, dataDir,
    resolveAppId: async () => ({ appId: "net.donable.app.testing", appVersion: null }),
  });

  const res = await request(app)
    .post("/run")
    .set("Authorization", `Bearer ${TOKEN}`)
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);

  expect(res.status).toBe(500);
  expect(fs.readdirSync(uploadDir)).toHaveLength(0);
}, TEST_TIMEOUT_MS);
