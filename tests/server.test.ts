import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import request from "supertest";
import { createServer } from "../src/server";
import { defaultRunner, type CommandRunner } from "../src/maestro";
import { openDatabase } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { JobRepository, PREVIEW_LIMIT } from "../src/store/jobRepository";
import { DeviceRepository } from "../src/store/deviceRepository";
import { UserRepository } from "../src/store/userRepository";
import { OrgRepository } from "../src/store/orgRepository";
import { OrgTokenRepository } from "../src/store/orgTokenRepository";
import { UserTokenRepository } from "../src/store/userTokenRepository";
import { expectSimulatedHostError } from "./helpers/hostHealth";

const TOKEN_ENCRYPTION_KEY = "0".repeat(64);

function makeRepo(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(path.join(dataDir, "farm.db"));
  migrate(db);
  const deviceRepo = new DeviceRepository(db);
  // Seeded with the same id the fake adb runners below answer for, so
  // prepareDevice's "is deviceId present in `adb devices`" check still finds
  // a match once the scheduler claims a device from the enrolled pool
  // instead of the job following a config value.
  deviceRepo.seedIfEmpty(TEST_DEVICE_ID);

  // Real repository-backed org tokens, not TOKENS_JSON env-var seeding -
  // these tests construct createServer() directly, never through
  // bootstrap(), so the org/token setup has to happen here. Token VALUES
  // are unchanged (still "donable-token-123"/"other-token-456") so every
  // existing test body's `.set("Authorization", `Bearer ${TOKENS.donable}`)`
  // keeps working without touching a single test body.
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

const TOKENS = { donable: "donable-token-123", other: "other-token-456" };

// A "smart" fake runner: real tar invocations are delegated to the real
// defaultRunner (so extraction genuinely happens on disk), while adb/maestro
// invocations are faked so tests don't need a real device/emulator.
const TEST_DEVICE_ID = "emulator-5554";
const TEST_APP_ID = "net.donable.app.testing";

/**
 * Every job now starts with a device-readiness probe (`adb -s <id> devices`).
 * The fakes below must answer it or prepareDevice reports the device missing
 * and no job gets as far as installing.
 */
function devicesReply(state = "device") {
  return { code: 0, stdout: `List of devices attached\n${TEST_DEVICE_ID}\t${state}\n`, stderr: "" };
}

function smartSuccessRunner(): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
    if (args.includes("devices")) return devicesReply();
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

function installFailsRunner(): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
    if (args.includes("devices")) return devicesReply();
    if (args.includes("install")) {
      return { code: 1, stdout: "", stderr: "INSTALL_FAILED_INSUFFICIENT_STORAGE" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

function extractFailsRunner(): CommandRunner {
  return async (file, args) => {
    if (file === "tar") {
      return { code: 1, stdout: "", stderr: "tar: unexpected end of file" };
    }
    if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
    if (args.includes("devices")) return devicesReply();
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

// A job now does real tar extraction, SQLite writes, artifact copying and
// debug-directory cleanup - not an in-memory Map update - and CI/dev
// machines regularly run several jest suites in parallel. 500ms (the old
// 50 * 10ms budget) was ample for the Map update but is not a realistic
// ceiling for actual filesystem + DB work under contention; a tight budget
// here doesn't make the job faster, it just makes the test flake under
// load. 5s has margin without the suite hanging when something is genuinely
// broken.
const TERMINAL_POLL_ATTEMPTS = 500;
const TERMINAL_POLL_INTERVAL_MS = 10;

async function waitForDone(app: ReturnType<typeof createServer>, id: string, token: string) {
  for (let i = 0; i < TERMINAL_POLL_ATTEMPTS; i++) {
    const res = await request(app).get(`/run/${id}`).set("Authorization", `Bearer ${token}`);
    if (res.body.status === "done" || res.body.status === "failed") return res.body;
    await new Promise((r) => setTimeout(r, TERMINAL_POLL_INTERVAL_MS));
  }
  throw new Error("job never reached a terminal status");
}

let uploadDir: string;
let apkPath: string;
let flowsArchivePath: string;
const FLOW_NAME = "map/map";

beforeAll(() => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-fixture-src-"));
  const scenariosDir = path.join(srcDir, "e2e", "scenarios", "map");
  fs.mkdirSync(scenariosDir, { recursive: true });
  fs.writeFileSync(path.join(scenariosDir, "map.yaml"), "appId: test\n---\n- launchApp\n");

  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-fixture-archive-"));
  flowsArchivePath = path.join(archiveDir, "flows.tar.gz");
  execFileSync("tar", ["-czf", flowsArchivePath, "-C", srcDir, "e2e"]);
});

let dataDir: string;
let repo: JobRepository;
let deviceRepo: DeviceRepository;
let userRepo: UserRepository;
let orgRepo: OrgRepository;
let orgTokenRepo: OrgTokenRepository;
let userTokenRepo: UserTokenRepository;
let publicDir: string;

beforeEach(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-upload-test-"));
  apkPath = path.join(os.tmpdir(), `fixture-${Date.now()}-${Math.random()}.apk`);
  fs.writeFileSync(apkPath, Buffer.from("fake apk bytes"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-data-test-"));
  ({ repo, deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo } = makeRepo(dataDir));
  publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-public-"));
  fs.writeFileSync(path.join(publicDir, "index.html"), "<html>shell</html>");
  fs.writeFileSync(path.join(publicDir, "jobs.html"), "<html>job detail shell</html>");
  fs.writeFileSync(path.join(publicDir, "login.html"), "<html>login shell</html>");
  fs.writeFileSync(path.join(publicDir, "devices.html"), "<html>devices shell</html>");
  fs.writeFileSync(path.join(publicDir, "history.html"), "<html>history shell</html>");
  fs.writeFileSync(path.join(publicDir, "404.html"), "<html>not found</html>");
  fs.mkdirSync(path.join(publicDir, "login")); // stands in for Next's real
  fs.mkdirSync(path.join(publicDir, "devices")); // export emitting a same-named
  fs.mkdirSync(path.join(publicDir, "history"));
  fs.writeFileSync(path.join(publicDir, "account.html"), "<html>account shell</html>");
  fs.mkdirSync(path.join(publicDir, "account"));
  // directory alongside each .html file (RSC-payload metadata, no index.html
  // inside) - the bug these two new tests below cover only reproduces when
  // that colliding directory actually exists on disk.
});

afterEach(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.rmSync(apkPath, { force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(publicDir, { recursive: true, force: true });
});

test("POST /run without a token is rejected", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir });
  const res = await request(app)
    .post("/run")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
  expect(res.status).toBe(401);
});

test("POST /run without an apk attached is rejected", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir });
  const res = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("flowsArchive", flowsArchivePath);
  expect(res.status).toBe(400);

  expect(fs.readdirSync(uploadDir)).toHaveLength(0);
});

test("POST /run without a flowsArchive attached is rejected", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir });
  const res = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath);
  expect(res.status).toBe(400);

  expect(fs.readdirSync(uploadDir)).toHaveLength(0);
});

test("POST /run with a missing/invalid flows field is rejected", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir });

  const noFlows = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
  expect(noFlows.status).toBe(400);

  const malformedFlows = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", "not-json")
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
  expect(malformedFlows.status).toBe(400);

  const emptyFlows = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
  expect(emptyFlows.status).toBe(400);

  expect(fs.readdirSync(uploadDir)).toHaveLength(0);
});

test("GET /run/:id for an unknown id returns 404", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir });
  const res = await request(app)
    .get("/run/does-not-exist")
    .set("Authorization", "Bearer donable-token-123");
  expect(res.status).toBe(404);
});

test("the uploaded apk is handed to adb with a .apk suffix", async () => {
  // Regression: multer's default random filename has no extension, and
  // `adb install` rejects anything not ending .apk/.apex — every real job
  // failed with "filename doesn't end .apk" until the upload was named.
  const installArgs: string[][] = [];
  const captureRunner: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
    if (args.includes("devices")) return devicesReply();
    if (args.includes("install")) installArgs.push(args);
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: captureRunner,
    uploadDir,
    repo,
    dataDir,
  });

  const post = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);

  await waitForDone(app, post.body.id, "donable-token-123");

  expect(installArgs).toHaveLength(1);
  expect(installArgs[0][installArgs[0].length - 1]).toMatch(/\.apk$/);
});

test("a full run: install + real extraction succeed, flows run, job reaches done, all temp artifacts cleaned up", async () => {
  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: smartSuccessRunner(),
    uploadDir,
    repo,
    dataDir,
  });

  const post = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);

  expect(post.status).toBe(202);
  expect(post.body.status).toBe("queued");

  const finished = await waitForDone(app, post.body.id, "donable-token-123");
  expect(finished.status).toBe("done");
  expect(finished.results).toHaveLength(1);
  expect(finished.results[0].passed).toBe(true);
  expect(finished.results[0].flow).toContain(path.join("e2e", "scenarios", `${FLOW_NAME}.yaml`));

  // Uploaded apk and archive should be gone.
  expect(fs.readdirSync(uploadDir)).toHaveLength(0);

  // The extraction temp dir (under uploadDir, prefix "mobile-farm-") should
  // also have been removed; none should remain after the job completes.
  const leftoverExtractDirs = fs
    .readdirSync(uploadDir)
    .filter((name) => name.startsWith("mobile-farm-"));
  expect(leftoverExtractDirs).toHaveLength(0);
});

test("unusable device: job aborts before install with a <device> result explaining why", async () => {
  // The real failure this guards against: the S10 dropped off USB entirely, so
  // flows ran against nothing and failed with confusing element-not-found
  // errors instead of naming the actual cause.
  const deviceGoneRunner: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
    if (args.includes("devices")) return { code: 0, stdout: "List of devices attached\n", stderr: "" };
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: deviceGoneRunner,
    uploadDir,
    repo,
    dataDir,
  });

  const post = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);

  expect(post.status).toBe(202);

  const finished = await waitForDone(app, post.body.id, "donable-token-123");
  expect(finished.status).toBe("done");
  expect(finished.results).toHaveLength(1);
  expect(finished.results[0].flow).toBe("<device>");
  expect(finished.results[0].passed).toBe(false);
  expect(finished.results[0].stderr).toMatch(/not present/i);

  // Temp artifacts are still cleaned up on this early exit.
  expect(fs.readdirSync(uploadDir)).toHaveLength(0);
});

test("install failure: job reaches done with exactly one failed <install> result and no flow results", async () => {
  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: installFailsRunner(),
    uploadDir,
    repo,
    dataDir,
  });

  const post = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);

  expect(post.status).toBe(202);

  const finished = await waitForDone(app, post.body.id, "donable-token-123");
  expect(finished.status).toBe("done");
  expect(finished.results).toHaveLength(1);
  expect(finished.results[0].flow).toBe("<install>");
  expect(finished.results[0].passed).toBe(false);

  expect(fs.readdirSync(uploadDir)).toHaveLength(0);
});

test("extraction failure: job reaches done with exactly one failed <extract> result and no flow results", async () => {
  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: extractFailsRunner(),
    uploadDir,
    repo,
    dataDir,
  });

  const post = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);

  expect(post.status).toBe(202);

  const finished = await waitForDone(app, post.body.id, "donable-token-123");
  expect(finished.status).toBe("done");
  expect(finished.results).toHaveLength(1);
  expect(finished.results[0].flow).toBe("<extract>");
  expect(finished.results[0].passed).toBe(false);
  expect(finished.results[0].stderr).toContain("tar");

  expect(fs.readdirSync(uploadDir)).toHaveLength(0);
});

test("GET /jobs is org-scoped: org A only sees org A's jobs", async () => {
  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: smartSuccessRunner(),
    uploadDir,
    repo,
    dataDir,
  });

  const postA = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
  expect(postA.status).toBe(202);

  const postB = await request(app)
    .post("/run")
    .set("Authorization", "Bearer other-token-456")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
  expect(postB.status).toBe(202);

  await waitForDone(app, postA.body.id, "donable-token-123");
  await waitForDone(app, postB.body.id, "other-token-456");

  const res = await request(app).get("/jobs").set("Authorization", "Bearer donable-token-123");
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
  expect(res.body[0].id).toBe(postA.body.id);
});

test("GET /jobs without a token is rejected", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir });
  const res = await request(app).get("/jobs");
  expect(res.status).toBe(401);
});

test("GET /status returns an HTML page containing the caller's job", async () => {
  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: smartSuccessRunner(),
    uploadDir,
    repo,
    dataDir,
  });

  const post = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
  expect(post.status).toBe(202);
  await waitForDone(app, post.body.id, "donable-token-123");

  const res = await request(app).get(`/status?token=donable-token-123`);
  expect(res.status).toBe(200);
  expect(res.type).toBe("text/html");
  expect(res.text).toContain(post.body.id);
});

test("GET /status is org-scoped: org A's page contains org A's job and not org B's", async () => {
  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: smartSuccessRunner(),
    uploadDir,
    repo,
    dataDir,
  });

  const postA = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
  expect(postA.status).toBe(202);

  const postB = await request(app)
    .post("/run")
    .set("Authorization", "Bearer other-token-456")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
  expect(postB.status).toBe(202);

  await waitForDone(app, postA.body.id, "donable-token-123");
  await waitForDone(app, postB.body.id, "other-token-456");

  const res = await request(app).get(`/status?token=donable-token-123`);
  expect(res.status).toBe(200);
  expect(res.text).toContain(postA.body.id);
  expect(res.text).not.toContain(postB.body.id);
});

test("GET /status without a token is rejected", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir });
  const res = await request(app).get("/status");
  expect(res.status).toBe(401);
});

test("cross-tenant: a job created by org A cannot be fetched with org B's valid token (404, not 403)", async () => {
  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: smartSuccessRunner(),
    uploadDir,
    repo,
    dataDir,
  });

  const post = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);

  expect(post.status).toBe(202);

  const res = await request(app)
    .get(`/run/${post.body.id}`)
    .set("Authorization", "Bearer other-token-456");
  expect(res.status).toBe(404);

  // Drain the job before the test ends: afterEach force-removes uploadDir,
  // and if the queued job is still running its cleanup races that removal -
  // unlink then fails with ENOENT on a directory that's already gone, and
  // Jest logs it after the suite has finished ("Cannot log after tests are
  // done"). Waiting here keeps the background work inside the test's own
  // lifetime instead of leaking into the next one's.
  await waitForDone(app, post.body.id, "donable-token-123");
});

test("a failure to even start the job (e.g. extraction dir creation) still reaches a terminal status, not stuck queued", async () => {
  // This test induces ENOSPC on purpose (see the mkdtempSync mock below), so
  // it must tell the host-health guard not to read that as the machine
  // genuinely running out of disk. Without this the guard fails the test.
  expectSimulatedHostError();

  // Regression for a real bug: fs.mkdtempSync(uploadRoot, "mobile-farm-")
  // runs inside the queue callback but outside runJob's own try/catch. If it
  // throws - full disk, permissions, uploadRoot removed underneath us - the
  // job used to stay "queued" forever. CI polls GET /run/:id until its own
  // timeout and only then falls back to a paid device cloud, which is the
  // exact cost this service exists to avoid. Multer doesn't call
  // fs.mkdtempSync at all (it writes via its own random-name stream), so
  // spying on just that call fails only the extraction-dir step and leaves
  // the real upload untouched.
  const mkdtempSpy = jest.spyOn(fs, "mkdtempSync").mockImplementationOnce(() => {
    throw new Error("ENOSPC: no space left on device, mkdtemp");
  });

  try {
    const app = createServer({
      userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
      deviceId: "emulator-5554", deviceRepo,
      resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
      runner: smartSuccessRunner(),
      uploadDir,
      repo,
      dataDir,
    });

    const post = await request(app)
      .post("/run")
      .set("Authorization", "Bearer donable-token-123")
      .field("flows", JSON.stringify([FLOW_NAME]))
      .attach("apk", apkPath)
      .attach("flowsArchive", flowsArchivePath);

    expect(post.status).toBe(202);

    const finished = await waitForDone(app, post.body.id, "donable-token-123");
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("ENOSPC");
  } finally {
    mkdtempSpy.mockRestore();
  }
});

test("a failed install's stderr longer than PREVIEW_LIMIT is returned in full by GET /run/:id", async () => {
  // Setup steps write no artifacts of their own by default, so readOutput in
  // server.ts fell back to the stored preview - truncated at PREVIEW_LIMIT by
  // finishStep. CI used to get the FULL adb output for an install failure;
  // losing the tail of a real INSTALL_FAILED_* message is exactly the wrong
  // moment to lose detail.
  const longStderr = "INSTALL_FAILED_INSUFFICIENT_STORAGE ".repeat(200);
  expect(longStderr.length).toBeGreaterThan(PREVIEW_LIMIT);

  const longInstallFailureRunner: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
    if (args.includes("devices")) return devicesReply();
    if (args.includes("install")) {
      return { code: 1, stdout: "", stderr: longStderr };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const app = createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: longInstallFailureRunner,
    uploadDir,
    repo,
    dataDir,
  });

  const post = await request(app)
    .post("/run")
    .set("Authorization", "Bearer donable-token-123")
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);

  const finished = await waitForDone(app, post.body.id, "donable-token-123");
  expect(finished.results).toHaveLength(1);
  expect(finished.results[0].flow).toBe("<install>");
  expect(finished.results[0].stderr).toBe(longStderr);
  expect(finished.results[0].stderr.length).toBeGreaterThan(PREVIEW_LIMIT);
});

test("serves the dashboard shell at /", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir, publicDir });
  const res = await request(app).get("/");
  expect(res.status).toBe(200);
  expect(res.text).toContain("shell");
});

test("serves jobs.html for any /jobs/:id path", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir, publicDir });
  const res = await request(app).get("/jobs/some-job-id-123");
  expect(res.status).toBe(200);
  expect(res.text).toContain("job detail shell");
});

test("does not shadow the /api/jobs API route with the static fallback", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir, publicDir });
  const res = await request(app).get("/api/jobs").set("Authorization", "Bearer donable-token-123");
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty("jobs");
});

test("serves login.html at /login even though a same-named directory also exists", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir, publicDir });
  const res = await request(app).get("/login");
  expect(res.status).toBe(200);
  expect(res.text).toContain("login shell");
});

test("serves devices.html at /devices even though a same-named directory also exists", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir, publicDir });
  const res = await request(app).get("/devices");
  expect(res.status).toBe(200);
  expect(res.text).toContain("devices shell");
});

test("serves history.html at /history even though a same-named directory also exists", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir, publicDir });
  const res = await request(app).get("/history");
  expect(res.status).toBe(200);
  expect(res.text).toContain("history shell");
});

test("serves 404.html with a 404 status for an unknown path instead of falling through to auth", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir, publicDir });
  const res = await request(app).get("/some-unknown-path");
  expect(res.status).toBe(404);
  expect(res.text).toContain("not found");
});

test("the 404 fallback does not shadow /api/*: an unauthenticated GET /api/jobs still returns 401, not 404", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir, publicDir });
  const res = await request(app).get("/api/jobs");
  expect(res.status).toBe(401);
});

test("serves account.html at /account even though a same-named directory also exists", async () => {
  const app = createServer({ userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret", deviceId: "emulator-5554", deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }), uploadDir, repo, dataDir, publicDir });
  const res = await request(app).get("/account");
  expect(res.status).toBe(200);
  expect(res.text).toContain("account shell");
});
