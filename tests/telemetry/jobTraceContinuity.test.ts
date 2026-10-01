import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import request from "supertest";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { startTestTracing } from "../helpers/otelTestProvider";
import { withSpan } from "../../src/telemetry/tracer";
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

// Adapted from the deleted src/queue.ts version (git show 69e0763~:tests/telemetry/jobTraceContinuity.test.ts)
// for the Scheduler, which claims and dispatches jobs asynchronously rather
// than chaining promises. The properties pinned are unchanged: a job runs
// inside the trace that submitted it, and a later job does not inherit an
// earlier job's trace. What differs is how continuity has to be carried -
// see the comment on traceCtxByJob in src/server.ts.

const TOKEN_ENCRYPTION_KEY = "1".repeat(64);
const TOKEN = "trace-continuity-token";
const TEST_DEVICE_ID = "emulator-5554";
const TEST_APP_ID = "net.donable.app.testing";
const FLOW_NAME = "map/map";
const TEST_TIMEOUT_MS = 20000;
const TERMINAL_POLL_ATTEMPTS = 500;
const TERMINAL_POLL_INTERVAL_MS = 10;

function devicesReply() {
  return { code: 0, stdout: `List of devices attached\n${TEST_DEVICE_ID}\tdevice\n`, stderr: "" };
}

// Real tar extraction, faked adb/maestro - same shape as server.test.ts's
// smartSuccessRunner, so a job actually reaches a terminal state without
// touching a real device.
function smartSuccessRunner(): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
    if (args.includes("devices")) return devicesReply();
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

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
  const org = orgRepo.create("trace-continuity-org", [admin.id]);
  orgTokenRepo.create(org.id, "test", TOKEN, admin.id);

  return { repo: new JobRepository(db), deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo };
}

async function waitForDone(app: ReturnType<typeof createServer>, id: string) {
  for (let i = 0; i < TERMINAL_POLL_ATTEMPTS; i++) {
    const res = await request(app).get(`/run/${id}`).set("Authorization", `Bearer ${TOKEN}`);
    if (res.body.status === "done" || res.body.status === "failed") return res.body;
    await new Promise((r) => setTimeout(r, TERMINAL_POLL_INTERVAL_MS));
  }
  throw new Error("job never reached a terminal status");
}

function submit(app: ReturnType<typeof createServer>, apkPath: string, flowsArchivePath: string) {
  return request(app)
    .post("/run")
    .set("Authorization", `Bearer ${TOKEN}`)
    .field("flows", JSON.stringify([FLOW_NAME]))
    .attach("apk", apkPath)
    .attach("flowsArchive", flowsArchivePath);
}

let exporter: InMemorySpanExporter;
let stopTracing: () => void;
let uploadDir: string;
let apkPath: string;
let flowsArchivePath: string;
let dataDir: string;

beforeAll(() => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-trace-fixture-src-"));
  const scenariosDir = path.join(srcDir, "e2e", "scenarios", "map");
  fs.mkdirSync(scenariosDir, { recursive: true });
  fs.writeFileSync(path.join(scenariosDir, "map.yaml"), "appId: test\n---\n- launchApp\n");

  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-trace-fixture-archive-"));
  flowsArchivePath = path.join(archiveDir, "flows.tar.gz");
  execFileSync("tar", ["-czf", flowsArchivePath, "-C", srcDir, "e2e"]);
});

beforeEach(() => {
  ({ exporter, stop: stopTracing } = startTestTracing());
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-trace-upload-"));
  apkPath = path.join(os.tmpdir(), `trace-fixture-${Date.now()}-${Math.random()}.apk`);
  fs.writeFileSync(apkPath, Buffer.from("fake apk bytes"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-trace-data-"));
});

afterEach(() => {
  stopTracing();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.rmSync(apkPath, { force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test(
  "a job runs inside the trace that submitted it",
  async () => {
    const deps = makeDeps(dataDir);
    const app = createServer({
      ...deps,
      sessionSecret: "test-session-secret",
      deviceId: TEST_DEVICE_ID,
      uploadDir,
      dataDir,
      resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
      runner: smartSuccessRunner(),
    });

    const post = await withSpan("POST /run", {}, async () => submit(app, apkPath, flowsArchivePath));
    expect(post.status).toBe(202);
    await waitForDone(app, post.body.id);

    const submitSpan = exporter.getFinishedSpans().find((s) => s.name === "POST /run")!;
    const jobSpan = exporter.getFinishedSpans().find((s) => s.name === "job")!;
    expect(submitSpan).toBeDefined();
    expect(jobSpan).toBeDefined();

    expect(jobSpan.spanContext().traceId).toBe(submitSpan.spanContext().traceId);
    expect(jobSpan.parentSpanContext?.spanId).toBe(submitSpan.spanContext().spanId);
  },
  TEST_TIMEOUT_MS
);

test(
  "a second job does not inherit the first job's trace",
  async () => {
    const deps = makeDeps(dataDir);
    const app = createServer({
      ...deps,
      sessionSecret: "test-session-secret",
      deviceId: TEST_DEVICE_ID,
      uploadDir,
      dataDir,
      resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
      runner: smartSuccessRunner(),
    });

    // Only one device is enrolled, so the second job queues behind the first
    // and is claimed from the scheduler's completion dispatch (the .finally()
    // path) rather than from its own submit() - exactly the path that would
    // wrongly inherit the PREVIOUS job's context if capture happened at claim
    // time instead of at submit time.
    const first = await withSpan("submit-a", {}, async () => submit(app, apkPath, flowsArchivePath));
    expect(first.status).toBe(202);

    // A second, distinct apk file so the second upload doesn't collide with
    // the first mid-flight.
    const secondApkPath = path.join(os.tmpdir(), `trace-fixture-second-${Date.now()}-${Math.random()}.apk`);
    fs.writeFileSync(secondApkPath, Buffer.from("fake apk bytes 2"));
    try {
      const second = await withSpan("submit-b", {}, async () => submit(app, secondApkPath, flowsArchivePath));
      expect(second.status).toBe(202);

      await waitForDone(app, first.body.id);
      await waitForDone(app, second.body.id);

      const jobSpans = exporter.getFinishedSpans().filter((s) => s.name === "job");
      expect(jobSpans).toHaveLength(2);
      const [jobA, jobB] = jobSpans;

      expect(jobA.spanContext().traceId).not.toBe(jobB.spanContext().traceId);
    } finally {
      fs.rmSync(secondApkPath, { force: true });
    }
  },
  TEST_TIMEOUT_MS
);
