// tests/mcp/integration.test.ts
//
// The only test in the suite that runs the real MCP client (src/mcp/*)
// against the real createServer() over an actual loopback HTTP listener,
// with a faked adb/maestro CommandRunner underneath. Every other MCP test
// exercises tools against a hand-rolled fake FarmClient; this is the one
// that would catch the client and server disagreeing about response shape.
//
// Harness copied from tests/server.test.ts (read that file first) rather
// than invented fresh, per the task brief.
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
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
import { createFarmClient, type FarmClient } from "../../src/mcp/client";
import { runFlows } from "../../src/mcp/tools/runFlows";
import { waitForJob } from "../../src/mcp/tools/waitForJob";
import { listJobs, getJob, getDevice } from "../../src/mcp/tools/reads";
import { getArtifact } from "../../src/mcp/tools/getArtifact";

const TEST_DEVICE_ID = "emulator-5554";
const TEST_APP_ID = "net.donable.app.testing";
const TOKEN = "donable-token-123";
const TOKEN_ENCRYPTION_KEY = "0".repeat(64);

// Same "smart" fake as tests/server.test.ts: real tar invocations delegate
// to the real defaultRunner (so extraction genuinely happens on disk),
// while adb/maestro invocations are faked. Must answer the device-readiness
// probe (`adb -s <id> devices`) or prepareDevice reports the device missing
// and no job gets as far as installing.
function smartSuccessRunner(): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("get-state")) return { code: 0, stdout: "device", stderr: "" };
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${TEST_DEVICE_ID}\tdevice\n`, stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

let dataDir: string;
let uploadDir: string;
let http: Server;
let baseUrl: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-int-data-"));
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-int-upload-"));

  const db = openDatabase(path.join(dataDir, "farm.db"));
  migrate(db);
  const deviceRepo = new DeviceRepository(db);
  deviceRepo.seedIfEmpty(TEST_DEVICE_ID);

  const userRepo = new UserRepository(db);
  const orgRepo = new OrgRepository(db);
  const orgTokenRepo = new OrgTokenRepository(db, TOKEN_ENCRYPTION_KEY);
  const userTokenRepo = new UserTokenRepository(db, TOKEN_ENCRYPTION_KEY);
  const admin = userRepo.create({ username: "admin", email: "admin@example.com", password: "x", isAdmin: true });
  const org = orgRepo.create("donable", [admin.id]);
  orgTokenRepo.create(org.id, "test", TOKEN, admin.id);

  const app = createServer({
    userRepo,
    orgRepo,
    orgTokenRepo,
    userTokenRepo,
    sessionSecret: "test-session-secret",
    deviceId: TEST_DEVICE_ID,
    deviceRepo,
    resolveAppId: async () => ({ appId: TEST_APP_ID, appVersion: null }),
    runner: smartSuccessRunner(),
    uploadDir,
    repo: new JobRepository(db),
    dataDir,
  });

  http = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

const client = () => createFarmClient({ farmUrl: baseUrl, token: TOKEN, timeoutMs: 30000 });

/** waitForJob has a correct, deliberate fallback: if the SSE stream yields
 * nothing usable it polls GET /api/jobs/:id once and formats that. That
 * fallback also makes the end-to-end assertions blind - they pass
 * identically whether SSE works or is completely broken, because the polled
 * detail carries the same jobId and the same terminal status. So count the
 * frames that actually satisfy waitForJob's own `isDetail` predicate (an
 * object with a `job` key - the exact shape it keys off) and assert at least
 * one arrived. This is the only assertion in the suite that can see SSE
 * frame-shape drift. */
function sseCountingClient(): { client: FarmClient; detailFrames: () => number } {
  const inner = client();
  let detailFrames = 0;
  return {
    client: {
      ...inner,
      openEvents: (path, onFrame, signal) =>
        inner.openEvents(path, (frame) => {
          if (typeof frame === "object" && frame !== null && "job" in frame) detailFrames += 1;
          onFrame(frame);
        }, signal),
    },
    detailFrames: () => detailFrames,
  };
}

describe("mcp client against the real farm api", () => {
  it("runs a job end to end: run_flows -> wait_for_job -> get_job", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-int-src-"));
    try {
      const apk = path.join(work, "app.apk");
      fs.writeFileSync(apk, "apk");
      const e2e = path.join(work, "e2e");
      fs.mkdirSync(path.join(e2e, "scenarios"), { recursive: true });
      fs.writeFileSync(path.join(e2e, "scenarios", "map.yaml"), "appId: test\n---\n- launchApp\n");

      const started = await runFlows(client(), { apkPath: apk, flows: ["map"], e2eDir: e2e });
      expect(started.isError).toBeUndefined();
      const startedText = (started.content[0] as { text: string }).text;
      const jobId = startedText.match(/job (\S+)/)?.[1];
      expect(jobId).toBeTruthy();

      const watcher = sseCountingClient();
      const finished = await waitForJob(watcher.client, { jobId: jobId as string, timeoutSeconds: 30 });
      expect(finished.isError).toBeUndefined();
      const finishedText = (finished.content[0] as { text: string }).text;
      expect(finishedText).toContain(jobId as string);
      expect(finishedText).toMatch(/done|failed/);
      // The result above would look identical if SSE were broken and the
      // poll fallback produced it. This is what says the stream ran.
      expect(watcher.detailFrames()).toBeGreaterThan(0);

      const detail = await getJob(client(), { jobId: jobId as string });
      expect(detail.isError).toBeUndefined();
      const detailText = (detail.content[0] as { text: string }).text;
      expect(detailText).toContain("map");

      // ArtifactRow end to end: collectArtifacts() always writes stdout.log
      // and stderr.log for a flow step (src/artifacts/collector.ts), so a
      // real flow run must produce at least one artifact line in the shape
      // formatJobDetail() emits: "        <kind> (id <n>, <n> bytes)". If
      // this ever stopped matching, ArtifactRow's field names (id/kind/bytes)
      // would be the thing that drifted.
      expect(detailText).toMatch(/\(id \d+, \d+ bytes\)/);

      // get_artifact against the real range-supporting route (89e9a47): its
      // probe asks for `bytes=0-0` and the server answers 206 with a
      // Content-Range total, and an empty artifact (an empty stderr.log is
      // routine) makes that probe unsatisfiable - 416 - which the tool has
      // to survive. Both shapes are among the artifacts of a real run, so
      // fetch every one of them.
      const artifactIds = [...detailText.matchAll(/\(id (\d+), (\d+) bytes\)/g)]
        .map((m) => ({ id: Number(m[1]), bytes: Number(m[2]) }));
      expect(artifactIds.length).toBeGreaterThan(0);
      for (const artifact of artifactIds) {
        const fetched = await getArtifact(client(), baseUrl, { artifactId: artifact.id });
        expect(fetched.isError).toBeUndefined();
        expect((fetched.content[0] as { text: string }).text).toContain(`${artifact.bytes} bytes`);
      }

      // list_jobs renders server-computed progress fields (flowCount/passed/
      // failed), distinct from the JobDetail fields checked above - assert
      // through them here too, using the job we just ran, so a rename of any
      // of those fields prints "undefined" into the text and fails this
      // assertion instead of silently passing.
      const jobsAfterRun = await listJobs(client(), {});
      expect(jobsAfterRun.isError).toBeUndefined();
      const jobsText = (jobsAfterRun.content[0] as { text: string }).text;
      const jobLine = jobsText.split("\n").find((line) => line.startsWith(jobId as string));
      expect(jobLine).toBeDefined();
      // "<id>  <status>  <passed> passed, <failed> failed of <flowCount>  <when>"
      expect(jobLine).toMatch(/^\S+\s+(done|failed)\s+\d+ passed, \d+ failed of \d+\s+\S/);
      expect(jobLine).toContain("1 passed, 0 failed of 1");
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }, 60000);

  it("list_jobs and get_device parse the real payloads without error", async () => {
    const jobs = await listJobs(client(), {});
    expect(jobs.isError).toBeUndefined();
    const jobsText = (jobs.content[0] as { text: string }).text;
    // Every rendered line must carry real numbers, not "undefined" - a
    // renamed JobSummary field (flowCount/passed/failed) would print
    // "undefined" here and set no error, so isError alone cannot catch it.
    for (const line of jobsText.split("\n")) {
      expect(line).toMatch(/^\S+\s+(queued|running|done|failed)\s+\d+ passed, \d+ failed of \d+\s+\S/);
    }

    // get_device calls GET /api/devices (plural) - there is no /api/device.
    // get_device's own implementation is a raw JSON.stringify with no typed
    // field access at all, so nothing at runtime enforces DeviceResponse's
    // shape - the assertion has to parse the text back out and go through
    // the real key names itself, or a renamed field would never be caught.
    const device = await getDevice(client());
    expect(device.isError).toBeUndefined();
    const deviceText = (device.content[0] as { text: string }).text;
    const devicePayload = JSON.parse(deviceText) as {
      devices: Array<{ id: string; label: string; isActive: boolean; state: string }>;
      runnerVersion: string;
    };
    expect(typeof devicePayload.runnerVersion).toBe("string");
    expect(devicePayload.runnerVersion.length).toBeGreaterThan(0);
    expect(devicePayload.devices).toHaveLength(1);
    expect(devicePayload.devices[0].id).toBe(TEST_DEVICE_ID);
    expect(devicePayload.devices[0].isActive).toBe(true);
    expect(typeof devicePayload.devices[0].state).toBe("string");
    expect(devicePayload.devices[0].state.length).toBeGreaterThan(0);
  });

  it("reports a bad token as an auth error result, not a crash", async () => {
    const bad = createFarmClient({ farmUrl: baseUrl, token: "wrong-token", timeoutMs: 5000 });
    const result = await listJobs(bad, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/MOBILE_FARM_TOKEN/);
  });

  it("never echoes the token in an error, even when the token is the problem", async () => {
    const bad = createFarmClient({ farmUrl: baseUrl, token: "wrong-token", timeoutMs: 5000 });
    const result = await getJob(bad, { jobId: "nope" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("wrong-token");
  });
});
