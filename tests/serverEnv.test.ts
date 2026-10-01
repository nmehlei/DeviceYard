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

const TOKEN_ENCRYPTION_KEY = "0".repeat(64);
const TOKENS = { donable: "donable-token-123", other: "other-token-456" };
const TEST_DEVICE_ID = "emulator-5554";
const TEST_APP_ID = "net.donable.app.testing";
const FLOW_NAME = "map/map";

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

function smartSuccessRunner(): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) return devicesReply();
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

let uploadDir: string;
let apkPath: string;
let flowsArchivePath: string;

beforeAll(() => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-env-fixture-src-"));
  const scenariosDir = path.join(srcDir, "e2e", "scenarios", "map");
  fs.mkdirSync(scenariosDir, { recursive: true });
  fs.writeFileSync(path.join(scenariosDir, "map.yaml"), "appId: test\n---\n- launchApp\n");

  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-env-fixture-archive-"));
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

beforeEach(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-env-upload-test-"));
  apkPath = path.join(os.tmpdir(), `env-fixture-${Date.now()}-${Math.random()}.apk`);
  fs.writeFileSync(apkPath, Buffer.from("fake apk bytes"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-env-data-test-"));
  ({ repo, deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo } = makeRepo(dataDir));
});

afterEach(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.rmSync(apkPath, { force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function buildApp() {
  return createServer({
    userRepo, orgRepo, orgTokenRepo, userTokenRepo, sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID, deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: smartSuccessRunner(),
    uploadDir,
    repo,
    dataDir,
  });
}

describe("POST /run with env", () => {
  it("accepts a JSON-encoded env and stores it masked on the job", async () => {
    const app = buildApp();
    const post = await request(app)
      .post("/run")
      .set("Authorization", `Bearer ${TOKENS.donable}`)
      .field("flows", JSON.stringify([FLOW_NAME]))
      .field("env", JSON.stringify({ E2E_LAUNCHER: "samsung", E2E_TEST_PASSWORD: "hunter2222" }))
      .attach("apk", apkPath)
      .attach("flowsArchive", flowsArchivePath);

    expect(post.status).toBe(202);

    const job = repo.getJob(post.body.id);
    expect(job?.envJson).toBeTruthy();
    expect(job?.envJson).toContain("samsung");
    expect(job?.envJson).toContain("REDACTED");
    expect(job?.envJson).not.toContain("hunter2222");
  });

  it("still accepts a request with no env at all", async () => {
    const app = buildApp();
    const post = await request(app)
      .post("/run")
      .set("Authorization", `Bearer ${TOKENS.donable}`)
      .field("flows", JSON.stringify([FLOW_NAME]))
      .attach("apk", apkPath)
      .attach("flowsArchive", flowsArchivePath);

    expect(post.status).toBe(202);

    const job = repo.getJob(post.body.id);
    expect(job?.envJson).toBeNull();
  });

  it.each([
    ["invalid JSON", "{oops"],
    ["a non-object", '["A=1"]'],
    ["a non-string value", '{"A":1}'],
    ["an invalid key", '{"1BAD":"v"}'],
    ["a newline in a value", '{"A":"a\\nb"}'],
    ["a too-short secret", '{"MY_TOKEN":"ab"}'],
  ])("rejects %s with a 400 naming the problem", async (_label, raw) => {
    const app = buildApp();
    const post = await request(app)
      .post("/run")
      .set("Authorization", `Bearer ${TOKENS.donable}`)
      .field("flows", JSON.stringify([FLOW_NAME]))
      .field("env", raw)
      .attach("apk", apkPath)
      .attach("flowsArchive", flowsArchivePath);

    expect(post.status).toBe(400);
    expect(typeof post.body.error).toBe("string");
    expect(post.body.error.length).toBeGreaterThan(0);
  });

  it("names the offending key in the error, for a CLI to surface verbatim", async () => {
    const app = buildApp();
    const post = await request(app)
      .post("/run")
      .set("Authorization", `Bearer ${TOKENS.donable}`)
      .field("flows", JSON.stringify([FLOW_NAME]))
      .field("env", '{"1BAD":"v"}')
      .attach("apk", apkPath)
      .attach("flowsArchive", flowsArchivePath);

    expect(post.status).toBe(400);
    expect(post.body.error).toContain("1BAD");
  });

  it("cleans up uploaded files when env validation rejects the request", async () => {
    const app = buildApp();
    const post = await request(app)
      .post("/run")
      .set("Authorization", `Bearer ${TOKENS.donable}`)
      .field("flows", JSON.stringify([FLOW_NAME]))
      .field("env", "{oops")
      .attach("apk", apkPath)
      .attach("flowsArchive", flowsArchivePath);

    expect(post.status).toBe(400);
    expect(fs.readdirSync(uploadDir)).toHaveLength(0);
  });
});
