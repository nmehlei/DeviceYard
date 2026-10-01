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
const TOKENS = { donable: "donable-token-123" };
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

const TERMINAL_POLL_ATTEMPTS = 500;
const TERMINAL_POLL_INTERVAL_MS = 10;

async function waitForDone(app: ReturnType<typeof createServer>, id: string, token: string) {
  // This suite has flaked seven times across three cycles under parallel-load
  // (recorded in docs/open_issues.md, "cycle 5"). When the poll budget is
  // exhausted, report the last status actually observed - it distinguishes
  // "the job legitimately failed" (status "failed", a real bug) from "the
  // poll just timed out" (status still "queued"/"running", a load/budget
  // problem, not a job problem).
  let lastStatus = "<no response received>";
  for (let i = 0; i < TERMINAL_POLL_ATTEMPTS; i++) {
    const res = await request(app).get(`/run/${id}`).set("Authorization", `Bearer ${token}`);
    lastStatus = res.body.status ?? lastStatus;
    if (res.body.status === "done" || res.body.status === "failed") return res.body;
    await new Promise((r) => setTimeout(r, TERMINAL_POLL_INTERVAL_MS));
  }
  throw new Error(`job never reached a terminal status; last observed status was "${lastStatus}"`);
}

/**
 * The reproduction this whole cycle exists to defeat:
 * mobile-dev-inc/Maestro#2512 - every `-e` value gets written verbatim into
 * commands-*.json inside the --debug-output directory, which this farm
 * collects wholesale. The fake runner below reproduces that faithfully: it
 * does NOT invent its own directory to write into. It parses the real
 * --debug-output value out of the argument array Maestro would have
 * received, exactly the way the real `maestro` binary would have been
 * pointed at that directory. Writing anywhere else would make this test
 * pass while proving nothing about the real leak.
 */
const ENV = {
  E2E_TEST_USER: "momentum-ci",
  E2E_TEST_PASSWORD: "hunter2222",
  E2E_LAUNCHER: "samsung",
};

let maestroArgsSeen: string[][] = [];

function maskingProofRunner(): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
    if (args.includes("devices")) return devicesReply();
    if (file === "maestro") {
      maestroArgsSeen.push(args);

      const debugOutputIdx = args.indexOf("--debug-output");
      if (debugOutputIdx === -1) {
        throw new Error("test setup error: maestro invoked without --debug-output");
      }
      const debugDir = args[debugOutputIdx + 1];

      // Reproduce Maestro#2512: every -e value written verbatim into
      // commands-*.json in the debug-output directory.
      const commandsJson = JSON.stringify({
        commands: [
          { env: ENV },
          { note: `login as ${ENV.E2E_TEST_USER} password ${ENV.E2E_TEST_PASSWORD} on ${ENV.E2E_LAUNCHER}` },
        ],
      });
      fs.writeFileSync(path.join(debugDir, "commands-abc.json"), commandsJson);

      const stdout = `Running on ${ENV.E2E_LAUNCHER} as ${ENV.E2E_TEST_USER} / ${ENV.E2E_TEST_PASSWORD}`;
      return { code: 0, stdout, stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

let uploadDir: string;
let apkPath: string;
let flowsArchivePath: string;
let dataDir: string;

beforeAll(() => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-env-fixture-src-"));
  const scenariosDir = path.join(srcDir, "e2e", "scenarios", "map");
  fs.mkdirSync(scenariosDir, { recursive: true });
  fs.writeFileSync(path.join(scenariosDir, "map.yaml"), "appId: test\n---\n- launchApp\n");

  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-env-fixture-archive-"));
  flowsArchivePath = path.join(archiveDir, "flows.tar.gz");
  execFileSync("tar", ["-czf", flowsArchivePath, "-C", srcDir, "e2e"]);
});

beforeEach(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-env-upload-test-"));
  apkPath = path.join(os.tmpdir(), `env-fixture-${Date.now()}-${Math.random()}.apk`);
  fs.writeFileSync(apkPath, Buffer.from("fake apk bytes"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-env-data-test-"));
  maestroArgsSeen = [];
});

afterEach(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.rmSync(apkPath, { force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("env passthrough: the real secret reaches Maestro, but never reaches stored artifacts or job history", async () => {
  const { repo, deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo } = makeRepo(dataDir);

  const app = createServer({
    userRepo,
    orgRepo,
    orgTokenRepo,
    userTokenRepo,
    sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID,
    deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: maskingProofRunner(),
    uploadDir,
    repo,
    dataDir,
  });

  const post = await request(app)
    .post("/run")
    .set("Authorization", `Bearer ${TOKENS.donable}`)
    .field("flows", JSON.stringify([FLOW_NAME]))
    .field("env", JSON.stringify(ENV))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);

  expect(post.status).toBe(202);

  const finished = await waitForDone(app, post.body.id, TOKENS.donable);
  expect(finished.status).toBe("done");

  // --- Maestro received the real value ---
  const flowInvocation = maestroArgsSeen.find((args) => args.includes("test"));
  expect(flowInvocation).toBeDefined();
  expect(flowInvocation).toContain("-e");
  expect(flowInvocation).toContain(`E2E_TEST_PASSWORD=${ENV.E2E_TEST_PASSWORD}`);

  // --- Locate what was actually stored on disk for the flow step ---
  const flowStep = repo.getSteps(post.body.id).find((s) => s.kind === "flow");
  expect(flowStep).toBeDefined();
  const stepDir = path.join(dataDir, "artifacts", post.body.id, String(flowStep!.ordinal));

  const stdoutLog = fs.readFileSync(path.join(stepDir, "stdout.log"), "utf8");
  const commandsJson = fs.readFileSync(path.join(stepDir, "commands-abc.json"), "utf8");

  // --- Secret is absent from both stored artifacts ---
  expect(stdoutLog).not.toContain(ENV.E2E_TEST_PASSWORD);
  expect(commandsJson).not.toContain(ENV.E2E_TEST_PASSWORD);
  expect(stdoutLog).toContain("***REDACTED***");
  expect(commandsJson).toContain("***REDACTED***");

  // --- Non-secret values survive intact in both ---
  for (const artifact of [stdoutLog, commandsJson]) {
    expect(artifact).toContain(ENV.E2E_LAUNCHER);
    expect(artifact).toContain(ENV.E2E_TEST_USER);
  }

  // --- Job history (envJson) carries the non-secret value, not the secret ---
  const job = repo.getJob(post.body.id);
  expect(job).toBeDefined();
  expect(job!.envJson).toBeTruthy();
  expect(job!.envJson).toContain(ENV.E2E_LAUNCHER);
  expect(job!.envJson).not.toContain(ENV.E2E_TEST_PASSWORD);
});
