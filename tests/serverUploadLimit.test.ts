import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import request from "supertest";
import { createServer } from "../src/server";
import { defaultRunner, type CommandRunner } from "../src/maestro";
import { openDatabase } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { DEFAULT_MAX_UPLOAD_BYTES, JobRepository } from "../src/store/jobRepository";
import { DeviceRepository } from "../src/store/deviceRepository";
import { UserRepository } from "../src/store/userRepository";
import { OrgRepository } from "../src/store/orgRepository";
import { OrgTokenRepository } from "../src/store/orgTokenRepository";
import { UserTokenRepository } from "../src/store/userTokenRepository";

const TOKEN_ENCRYPTION_KEY = "0".repeat(64);
const TOKEN = "donable-token-123";
const TEST_DEVICE_ID = "emulator-5554";
const FLOW_NAME = "map/map";

let uploadDir: string;
let dataDir: string;
let apkPath: string;
let flowsArchivePath: string;
let repo: JobRepository;
let deps: ReturnType<typeof makeRepo>;

function makeRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  const deviceRepo = new DeviceRepository(db);
  deviceRepo.seedIfEmpty(TEST_DEVICE_ID);
  const userRepo = new UserRepository(db);
  const orgRepo = new OrgRepository(db);
  const orgTokenRepo = new OrgTokenRepository(db, TOKEN_ENCRYPTION_KEY);
  const userTokenRepo = new UserTokenRepository(db, TOKEN_ENCRYPTION_KEY);
  const admin = userRepo.create({ username: "admin", email: "a@example.com", password: "x", isAdmin: true });
  const org = orgRepo.create("donable", [admin.id]);
  orgTokenRepo.create(org.id, "test", TOKEN, admin.id);
  return { repo: new JobRepository(db), deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo };
}

function runner(): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${TEST_DEVICE_ID}\tdevice\n`, stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

beforeAll(() => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-ul-src-"));
  const scenarios = path.join(srcDir, "e2e", "scenarios", "map");
  fs.mkdirSync(scenarios, { recursive: true });
  fs.writeFileSync(path.join(scenarios, "map.yaml"), "appId: test\n---\n- launchApp\n");
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-ul-archive-"));
  flowsArchivePath = path.join(archiveDir, "flows.tar.gz");
  execFileSync("tar", ["-czf", flowsArchivePath, "-C", srcDir, "e2e"]);
});

beforeEach(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-ul-upload-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-ul-data-"));
  apkPath = path.join(os.tmpdir(), `ul-${Date.now()}-${Math.random()}.apk`);
  deps = makeRepo(dataDir);
  repo = deps.repo;
});

afterEach(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(apkPath, { force: true });
});

function buildApp() {
  return createServer({
    ...deps,
    sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID,
    resolveAppId: async () => ({ appId: "net.donable.app.testing", appVersion: null }),
    runner: runner(),
    uploadDir,
    dataDir,
  });
}

function writeApk(bytes: number) {
  fs.writeFileSync(apkPath, Buffer.alloc(bytes, 0x41));
}

function post(app: ReturnType<typeof buildApp>) {
  return request(app)
    .post("/run")
    .set("Authorization", `Bearer ${TOKEN}`)
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
}

describe("the upload cap", () => {
  it("rejects an over-cap upload with 413 naming the field and the limit", async () => {
    repo.setUploadSettings({ maxUploadBytes: 1024 });
    writeApk(4096);

    const res = await post(buildApp());

    expect(res.status).toBe(413);
    expect(res.body.error).toContain("apk");
    // The number has to be in the message: "too large" alone sends the
    // operator to the source to find out what the limit is.
    expect(res.body.error).toMatch(/0\.0 MB|MB/);
  });

  it("leaves no file behind in the upload directory after a rejection", async () => {
    repo.setUploadSettings({ maxUploadBytes: 1024 });
    writeApk(4096);

    await post(buildApp());

    // multer is supposed to remove both completed and in-flight files on
    // abort. The repo's contract is that a rejected request leaves nothing on
    // disk, so assert it rather than trusting the dependency.
    expect(fs.existsSync(uploadDir)).toBe(true);
    expect(fs.readdirSync(uploadDir)).toEqual([]);
  });

  it("accepts an upload just under the cap unchanged", async () => {
    repo.setUploadSettings({ maxUploadBytes: 64 * 1024 });
    writeApk(1024);

    const res = await post(buildApp());

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    // Accepted payloads have moved from temporary uploads into durable storage.
    expect(fs.existsSync(path.join(dataDir, 'job-inputs', res.body.id, 'app.apk'))).toBe(true);
  });

  it("enforces the 512 MB default when nothing has been configured", async () => {
    expect(repo.getUploadSettings()).toBeUndefined();
    expect(repo.effectiveUploadLimit()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    writeApk(1024);

    // A normal-sized upload is unaffected by the default being active, which
    // is the property that keeps the live pipeline working.
    expect((await post(buildApp())).status).toBe(202);
  });

  it("accepts any size once an admin has explicitly cleared the limit", async () => {
    repo.setUploadSettings({ maxUploadBytes: null });
    writeApk(2 * 1024 * 1024);

    expect((await post(buildApp())).status).toBe(202);
  });

  it("applies a newly saved limit without restarting the server", async () => {
    // The regression guard for building multer per request: with a hoisted
    // instance this passes at first and then keeps passing after the limit
    // drops, because the middleware froze its fileSize at construction.
    const app = buildApp();
    writeApk(4096);
    expect((await post(app)).status).toBe(202);

    repo.setUploadSettings({ maxUploadBytes: 1024 });

    expect((await post(app)).status).toBe(413);
  });
});

describe("upload errors are JSON, not HTML", () => {
  it("names an unexpected file field", async () => {
    writeApk(64);

    // Exactly two files, so the files:2 cap is not what rejects this - it has
    // to be the field name itself.
    const res = await request(buildApp())
      .post("/run")
      .set("Authorization", `Bearer ${TOKEN}`)
      .field("flows", JSON.stringify([FLOW_NAME]))
      .attach("apk", apkPath)
      .attach("surprise", Buffer.from("x"), "surprise.txt");

    expect(res.status).toBe(400);
    expect(res.type).toBe("application/json");
    expect(res.body.error).toContain("surprise");
  });

  it("rejects more files than the route ever expects", async () => {
    writeApk(64);

    const res = await request(buildApp())
      .post("/run")
      .set("Authorization", `Bearer ${TOKEN}`)
      .field("flows", JSON.stringify([FLOW_NAME]))
      .attach("apk", apkPath)
      .attach("flowsArchive", flowsArchivePath)
      .attach("surprise", Buffer.from("x"), "surprise.txt");

    expect(res.status).toBe(400);
    expect(res.type).toBe("application/json");
    expect(res.body.error).toContain("LIMIT_FILE_COUNT");
  });

  it("returns JSON rather than Express's default HTML error page", async () => {
    repo.setUploadSettings({ maxUploadBytes: 1024 });
    writeApk(4096);

    const res = await post(buildApp());

    // Before this branch the app had no error handler at all, so a multer
    // rejection produced an HTML page - to a CI script parsing .error with jq.
    expect(res.type).toBe("application/json");
    expect(res.text).not.toContain("<!DOCTYPE");
  });
});
