// tests/appIdFromApk.test.ts
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import request from "supertest";
import { createServer } from "../src/server";
import { defaultRunner, type CommandRunner } from "../src/maestro";
import { openDatabase } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { JobRepository } from "../src/store/jobRepository";
import { DeviceRepository } from "../src/store/deviceRepository";
import { UserRepository } from "../src/store/userRepository";
import { OrgRepository } from "../src/store/orgRepository";
import { OrgTokenRepository } from "../src/store/orgTokenRepository";
import { UserTokenRepository } from "../src/store/userTokenRepository";
import { resolveAppIdFromApk } from "../src/appId";

/** These tests build real APKs with `zip`, POST them through the whole server,
 * and run a job to completion. That is well over Jest's 5s default on a busy
 * machine - and because the default is a per-test wall clock, they failed
 * intermittently rather than consistently, which is the worst way for a test
 * to be wrong: green locally, red in CI, and blamed on whatever changed last. */
jest.setTimeout(60000);

const TOKEN_ENCRYPTION_KEY = "0".repeat(64);
const TOKENS = { donable: "donable-token-123", momentum: "momentum-token-456" };
const TEST_DEVICE_ID = "emulator-5554";
const FLOW_NAME = "map/map";

const APKS = {
  donable: { path: path.join(__dirname, "fixtures/selendroid-test-app.apk"), packageName: "io.selendroid.testapp" },
  momentum: { path: path.join(__dirname, "fixtures/ContactManager.apk"), packageName: "com.example.android.contactmanager" },
};

describe("resolveAppIdFromApk - version extraction", () => {
  test("returns the real APK's package name as appId and its real version string", async () => {
    const info = await resolveAppIdFromApk(APKS.donable.path);
    expect(info.appId).toBe(APKS.donable.packageName);
    expect(info.appVersion).toBe("0.12.0-SNAPSHOT (1)");
  });

  test("returns ContactManager.apk's real package name and version string", async () => {
    const info = await resolveAppIdFromApk(APKS.momentum.path);
    expect(info.appId).toBe(APKS.momentum.packageName);
    expect(info.appVersion).toBe("1.0 (1)");
  });
});

function makeRepo(dataDir: string) {
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
  for (const [org, token] of Object.entries(TOKENS)) {
    const created = orgRepo.create(org, [admin.id]);
    orgTokenRepo.create(created.id, "test", token, admin.id);
  }

  return { repo: new JobRepository(db), deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo };
}

function devicesReply(state = "device") {
  return { code: 0, stdout: `List of devices attached\n${TEST_DEVICE_ID}\t${state}\n`, stderr: "" };
}

const TERMINAL_POLL_ATTEMPTS = 500;
const TERMINAL_POLL_INTERVAL_MS = 10;

async function waitForDone(app: ReturnType<typeof createServer>, id: string, token: string) {
  let lastStatus = "<no response received>";
  for (let i = 0; i < TERMINAL_POLL_ATTEMPTS; i++) {
    const res = await request(app).get(`/run/${id}`).set("Authorization", `Bearer ${token}`);
    lastStatus = res.body.status ?? lastStatus;
    if (res.body.status === "done" || res.body.status === "failed") return res.body;
    await new Promise((r) => setTimeout(r, TERMINAL_POLL_INTERVAL_MS));
  }
  throw new Error(`job never reached a terminal status; last observed status was "${lastStatus}"`);
}

// device.ts's "clear app data" step is the one adb call that names the
// resolved app id and nothing else - see docs/superpowers/plans for the
// same technique used against app-binary-info's own zip-layer tests.
let pmClearArgsSeen: string[] = [];

function appIdCapturingRunner(): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (file === "adb") {
      if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
      if (args.includes("devices")) return devicesReply();
      if (args.includes("pm") && args.includes("clear")) {
        pmClearArgsSeen.push(args[args.length - 1]);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

let uploadDir: string;
let flowsArchivePath: string;
let dataDir: string;

beforeAll(() => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-appid-real-fixture-src-"));
  const scenariosDir = path.join(srcDir, "e2e", "scenarios", "map");
  fs.mkdirSync(scenariosDir, { recursive: true });
  fs.writeFileSync(path.join(scenariosDir, "map.yaml"), "appId: test\n---\n- launchApp\n");

  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-appid-real-fixture-archive-"));
  flowsArchivePath = path.join(archiveDir, "flows.tar.gz");
  execFileSync("tar", ["-czf", flowsArchivePath, "-C", srcDir, "e2e"]);
});

beforeEach(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-appid-real-upload-test-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-appid-real-data-test-"));
  pmClearArgsSeen = [];
});

afterEach(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function submitJob(app: ReturnType<typeof createServer>, token: string, apkPath: string) {
  const res = await request(app)
    .post("/run")
    .set("Authorization", `Bearer ${token}`)
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
  expect(res.status).toBe(202);
  return res.body.id as string;
}

test("an org submitting a real APK gets that APK's real package name as the resolved app id", async () => {
  const { repo, deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo } = makeRepo(dataDir);
  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo,
    sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID,
    deviceRepo,
    // No resolveAppId override - this is the real default resolver, reading
    // the actual uploaded APK.
    runner: appIdCapturingRunner(),
    uploadDir, repo, dataDir,
  });

  const jobId = await submitJob(app, TOKENS.donable, APKS.donable.path);
  const finished = await waitForDone(app, jobId, TOKENS.donable);
  expect(repo.getJob(jobId)?.appVersion).toBe("0.12.0-SNAPSHOT (1)");

  expect(finished.status).toBe("done");
  expect(pmClearArgsSeen).toEqual([APKS.donable.packageName]);
});

test("two orgs submitting two different real APKs get two different resolved app ids", async () => {
  const { repo, deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo } = makeRepo(dataDir);
  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo,
    sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID,
    deviceRepo,
    runner: appIdCapturingRunner(),
    uploadDir, repo, dataDir,
  });

  const donableJobId = await submitJob(app, TOKENS.donable, APKS.donable.path);
  await waitForDone(app, donableJobId, TOKENS.donable);
  expect(pmClearArgsSeen).toEqual([APKS.donable.packageName]);

  pmClearArgsSeen = [];
  const momentumJobId = await submitJob(app, TOKENS.momentum, APKS.momentum.path);
  await waitForDone(app, momentumJobId, TOKENS.momentum);
  expect(pmClearArgsSeen).toEqual([APKS.momentum.packageName]);
});

test("an APK with no AndroidManifest.xml is rejected with a 400, before a job is ever created", async () => {
  const { repo, deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo } = makeRepo(dataDir);
  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo,
    sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID,
    deviceRepo,
    runner: appIdCapturingRunner(),
    uploadDir, repo, dataDir,
  });

  const notAnApk = path.join(uploadDir, "not-an-apk.apk");
  fs.writeFileSync(notAnApk, Buffer.from("not a zip file at all"));

  const res = await request(app)
    .post("/run")
    .set("Authorization", `Bearer ${TOKENS.donable}`)
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", notAnApk)
    .attach("flowsArchive", flowsArchivePath);

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/not a valid zip file|not a recognizable APK/i);
  expect(repo.listJobs("donable")).toHaveLength(0);
});
