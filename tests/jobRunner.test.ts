import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { openDatabase, type Db } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { JobRepository } from "../src/store/jobRepository";
import { runJob } from "../src/jobRunner";
import { defaultRunner, type CommandRunner } from "../src/maestro";
import { JobEvents } from "../src/events";
import type { ProcessSpawner } from "../src/artifacts/recorder";

const DEVICE = "emulator-5554";
const APP_ID = "net.donable.app.testing";

let dir: string;
let dataDir: string;
let db: Db;
let repo: JobRepository;
let apkPath: string;
let archivePath: string;
let extractDir: string;

function okRunner(): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-runner-"));
  dataDir = path.join(dir, "data");
  db = openDatabase(path.join(dataDir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);

  const srcDir = path.join(dir, "src");
  const scenarios = path.join(srcDir, "e2e", "scenarios", "map");
  fs.mkdirSync(scenarios, { recursive: true });
  fs.writeFileSync(path.join(scenarios, "map.yaml"), "appId: test\n---\n- launchApp\n");
  archivePath = path.join(dir, "flows.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", srcDir, "e2e"]);

  apkPath = path.join(dir, "app.apk");
  fs.writeFileSync(apkPath, "not-an-apk");
  extractDir = fs.mkdtempSync(path.join(dir, "extract-"));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// A fake, not the real adb-shelling default: every test here runs in a
// sandbox with no attached device, and letting the real captureDeviceScreenshot
// default through would mean every test attempts (and fails/times out) a
// genuine `adb exec-out screencap` call. Returns a fixed, cheap PNG-shaped
// buffer - tests that care about failure instead override this per-call.
function fakeScreenshot(): jest.Mock {
  return jest.fn(async () => Buffer.from("fake-final-screenshot-bytes"));
}

function options(overrides: Partial<Parameters<typeof runJob>[0]> = {}) {
  const job = repo.createJob("donable", ["map/map"]);
  return {
    jobId: job.id,
    deviceId: DEVICE,
    appId: APP_ID,
    dataDir,
    apkPath,
    flowsArchivePath: archivePath,
    extractDir,
    repo,
    runner: okRunner(),
    captureScreenshot: fakeScreenshot(),
    ...overrides,
  };
}

test("a successful run marks every step passed and the job done", async () => {
  const opts = options();
  await runJob(opts);

  const job = repo.getJob(opts.jobId);
  expect(job?.status).toBe("done");
  expect(repo.getSteps(opts.jobId).map((s) => s.status)).toEqual(["passed", "passed", "passed", "passed"]);
});

test("each step is persisted as it lands, not all at the end", async () => {
  const seen: string[][] = [];
  const opts = options({
    onChange: (jobId) => seen.push(repo.getSteps(jobId).map((s) => s.status)),
  });

  await runJob(opts);

  // If results were only written at the end there would be no intermediate
  // snapshot containing both a finished step and a still-queued one.
  const partial = seen.find((snap) => snap.includes("passed") && snap.includes("queued"));
  expect(partial).toBeDefined();
});

test("a device that is not ready fails the device step and skips the rest", async () => {
  const noDevice: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) return { code: 0, stdout: "List of devices attached\n", stderr: "" };
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const opts = options({ runner: noDevice });
  await runJob(opts);

  const steps = repo.getSteps(opts.jobId);
  expect(steps[0].status).toBe("failed");
  expect(steps[0].stderrPreview).toContain("not present in `adb devices`");
  expect(steps.slice(1).every((s) => s.status === "skipped")).toBe(true);
  expect(repo.getJob(opts.jobId)?.status).toBe("done");
});

test("a failed install fails that step and skips the flows", async () => {
  const installFails: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    if (args.includes("install")) {
      return { code: 1, stdout: "", stderr: "INSTALL_FAILED_INSUFFICIENT_STORAGE" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const opts = options({ runner: installFails });
  await runJob(opts);

  const steps = repo.getSteps(opts.jobId);
  expect(steps.find((s) => s.name === "install")?.status).toBe("failed");
  expect(steps.find((s) => s.name === "map/map")?.status).toBe("skipped");
});

test("device cleanup warnings are recorded without failing the step", async () => {
  const warnRunner: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    if (args.includes("clear")) return { code: 1, stdout: "", stderr: "cannot clear" };
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const opts = options({ runner: warnRunner });
  await runJob(opts);

  const device = repo.getSteps(opts.jobId)[0];
  expect(device.status).toBe("passed");
  expect(device.warnings.join(" ")).toContain("clear app data");
});

test("the flow step records the resolved yaml path the CI contract reports", async () => {
  const opts = options();
  await runJob(opts);

  const flow = repo.getSteps(opts.jobId).find((s) => s.kind === "flow");
  expect(flow?.resolvedPath).toContain(path.join("e2e", "scenarios", "map", "map.yaml"));
});

test("artifacts are written for each flow, including the guaranteed end-of-flow screenshot", async () => {
  const opts = options();
  await runJob(opts);

  const flow = repo.getSteps(opts.jobId).find((s) => s.kind === "flow")!;
  const kinds = repo.getArtifacts(flow.id).map((a) => a.kind).sort();
  expect(kinds).toEqual(["screenshot", "stderr", "stdout"]);
});

test("uploads and the extraction directory are removed when the job ends", async () => {
  const opts = options();
  await runJob(opts);

  expect(fs.existsSync(opts.apkPath)).toBe(false);
  expect(fs.existsSync(opts.flowsArchivePath)).toBe(false);
  expect(fs.existsSync(opts.extractDir)).toBe(false);
});

test("an unexpected error fails the job rather than escaping", async () => {
  const explode: CommandRunner = async () => {
    throw new Error("adb segfaulted");
  };

  const opts = options({ runner: explode });
  await expect(runJob(opts)).resolves.toBeUndefined();

  const job = repo.getJob(opts.jobId);
  expect(job?.status).toBe("failed");
  expect(job?.error).toContain("adb segfaulted");
});

// Amendment 2c: prove that a screenshot written into the per-flow debug
// directory by Maestro (simulated here by a fake runner) is collected and
// recorded with kind "screenshot". Without wiring debugDir through, Maestro's
// screenshots would silently never be collected while every test still
// passed - which is exactly what happened before this test existed.
test("a screenshot written into the debug directory is collected as an artifact", async () => {
  const runnerWithScreenshot: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    if (file === "maestro") {
      const debugIdx = args.indexOf("--debug-output");
      if (debugIdx !== -1) {
        const debugDir = args[debugIdx + 1];
        fs.mkdirSync(debugDir, { recursive: true });
        fs.writeFileSync(path.join(debugDir, "screenshot-1.png"), "fake-png-bytes");
      }
      return { code: 0, stdout: "ok", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const opts = options({ runner: runnerWithScreenshot });
  await runJob(opts);

  const flow = repo.getSteps(opts.jobId).find((s) => s.kind === "flow")!;
  // Two screenshots now: Maestro's own debug-output capture, plus the
  // guaranteed end-of-flow capture added below.
  const kinds = repo.getArtifacts(flow.id).map((a) => a.kind).sort();
  expect(kinds).toEqual(["screenshot", "screenshot", "stderr", "stdout"]);
});

// The actual point of the feature: a flow that captures no screenshot of its
// own (no explicit takeScreenshot:, nothing auto-captured by Maestro because
// nothing failed) must still end up with a screenshot artifact - previously
// such a flow had none at all, and a flow that DID capture one only ever
// showed whatever early state that shot happened to be from.
test("a flow with no Maestro-captured screenshot still gets the guaranteed end-of-flow screenshot", async () => {
  const opts = options();
  await runJob(opts);

  const flow = repo.getSteps(opts.jobId).find((s) => s.kind === "flow")!;
  const artifacts = repo.getArtifacts(flow.id);
  const screenshot = artifacts.find((a) => a.kind === "screenshot");
  expect(screenshot).toBeDefined();
  expect(fs.readFileSync(path.join(dataDir, "artifacts", screenshot!.relPath))).toEqual(
    Buffer.from("fake-final-screenshot-bytes")
  );
});

// StepTimeline.tsx picks the LAST screenshot-kind artifact for a step
// (findLast) - the end-of-flow capture must be recorded after whatever
// Maestro itself captured, or it would never actually win that selection.
test("the end-of-flow screenshot is recorded after any screenshot Maestro itself captured, so it is the one StepTimeline picks", async () => {
  const runnerWithScreenshot: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    if (file === "maestro") {
      const debugIdx = args.indexOf("--debug-output");
      if (debugIdx !== -1) {
        const debugDir = args[debugIdx + 1];
        fs.mkdirSync(debugDir, { recursive: true });
        fs.writeFileSync(path.join(debugDir, "screenshot-1.png"), "maestros-own-shot");
      }
      return { code: 0, stdout: "ok", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const opts = options({ runner: runnerWithScreenshot });
  await runJob(opts);

  const flow = repo.getSteps(opts.jobId).find((s) => s.kind === "flow")!;
  const screenshots = repo.getArtifacts(flow.id).filter((a) => a.kind === "screenshot");
  expect(screenshots).toHaveLength(2);
  const last = screenshots[screenshots.length - 1];
  expect(fs.readFileSync(path.join(dataDir, "artifacts", last.relPath))).toEqual(
    Buffer.from("fake-final-screenshot-bytes")
  );
});

// Losing the end-of-flow shot must never turn a passing flow red - same
// best-effort principle as every other artifact here (see collectArtifacts'
// own docstring).
test("a failed end-of-flow screenshot capture is recorded as a warning, not a failure", async () => {
  const opts = options({
    captureScreenshot: jest.fn().mockRejectedValue(new Error("device offline")),
  });
  await runJob(opts);

  const flow = repo.getSteps(opts.jobId).find((s) => s.kind === "flow")!;
  expect(flow.status).toBe("passed");
  expect(flow.warnings.join(" ")).toContain("could not capture end-of-flow screenshot");
  expect(repo.getArtifacts(flow.id).some((a) => a.kind === "screenshot")).toBe(false);
});

// Finding 2 (fix round 1): collectArtifacts COPIES files out of the debug
// directory into dataDir/artifacts - it never moves them. Without an explicit
// removal, the debug tree lingers forever and every screenshot exists twice
// on disk, silently halving the accuracy of totalArtifactBytes(), the only
// early warning that the farm host is filling up.
test("the per-flow debug directory is removed after its artifacts are collected, but the artifacts remain", async () => {
  const runnerWithScreenshot: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    if (file === "maestro") {
      const debugIdx = args.indexOf("--debug-output");
      if (debugIdx !== -1) {
        const debugDir = args[debugIdx + 1];
        fs.mkdirSync(debugDir, { recursive: true });
        fs.writeFileSync(path.join(debugDir, "screenshot-1.png"), "fake-png-bytes");
      }
      return { code: 0, stdout: "ok", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const opts = options({ runner: runnerWithScreenshot });
  await runJob(opts);

  const flow = repo.getSteps(opts.jobId).find((s) => s.kind === "flow")!;
  const debugDir = path.join(dataDir, "debug", opts.jobId, String(flow.ordinal));
  expect(fs.existsSync(debugDir)).toBe(false);

  const artifacts = repo.getArtifacts(flow.id);
  expect(artifacts.some((a) => a.kind === "screenshot")).toBe(true);
  for (const artifact of artifacts) {
    expect(fs.existsSync(path.join(dataDir, "artifacts", artifact.relPath))).toBe(true);
  }
});

// Finding 3 (fix round 1): setup steps now write their full stdout/stderr as
// artifacts too, so a truncated preview is never the only copy on disk.
test("a failing install step's full stderr is recorded as an artifact, not just the truncated preview", async () => {
  const longStderr = "boom ".repeat(500);
  const installFails: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    if (args.includes("install")) {
      return { code: 1, stdout: "", stderr: longStderr };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const opts = options({ runner: installFails });
  await runJob(opts);

  const install = repo.getSteps(opts.jobId).find((s) => s.name === "install")!;
  const artifacts = repo.getArtifacts(install.id);
  const stderrArtifact = artifacts.find((a) => a.kind === "stderr")!;
  expect(stderrArtifact).toBeDefined();

  const full = fs.readFileSync(path.join(dataDir, "artifacts", stderrArtifact.relPath), "utf8");
  expect(full).toBe(longStderr);
  expect(full.length).toBeGreaterThan(2000);
});

// Also-add (fix round 1): pins amendment 1's cleanup-before-finishJob
// ordering so it cannot be silently reverted. The FIRST onChange call that
// observes a terminal status must already see the extraction directory gone.
test("regression: the extraction directory is already gone the moment the job first reports a terminal status", async () => {
  let sawGoneAtFirstTerminalObservation: boolean | undefined;

  const opts = options({
    onChange: (jobId) => {
      if (sawGoneAtFirstTerminalObservation !== undefined) return;
      const job = repo.getJob(jobId);
      if (job && (job.status === "done" || job.status === "failed")) {
        sawGoneAtFirstTerminalObservation = !fs.existsSync(extractDir);
      }
    },
  });

  await runJob(opts);

  expect(sawGoneAtFirstTerminalObservation).toBe(true);
});

// Blocker 1: a throwing SSE subscriber (e.g. res.write on a destroyed
// response) must never flip a passing job to failed. runJob calls
// onChange() -> events.publish() synchronously from inside its own try
// block, AFTER repo.finishJob(jobId, "done") - so before JobEvents isolated
// listener failures, an uncaught throw here landed in runJob's catch, which
// re-ran cleanup and overwrote the job as "failed". This drives onChange
// through a real JobEvents instance (not a bare callback) so it actually
// exercises publish()'s listener isolation.
test("a throwing SSE subscriber does not flip a passing job to failed", async () => {
  const events = new JobEvents();
  const opts = options({ onChange: (jobId) => events.publish(jobId) });
  events.subscribe(opts.jobId, () => {
    throw new Error("res.write on a destroyed response");
  });

  await runJob(opts);

  const job = repo.getJob(opts.jobId);
  expect(job?.status).toBe("done");
  expect(job?.status).not.toBe("failed");
});

// Blocker 2a: each flow step already removes its own debug/<jobId>/<ordinal>
// directory, but the debug/<jobId> parent itself was never removed - an
// empty directory per job that accumulates forever in a permanent location.
// cleanup() now removes the whole debug/<jobId> tree.
test("the job's debug directory (not just its per-flow subdirectories) is removed when the job ends", async () => {
  const opts = options();
  await runJob(opts);

  expect(fs.existsSync(path.join(dataDir, "debug", opts.jobId))).toBe(false);
});

test("records a video around each flow and stores it as a recording artifact", async () => {
  const spawnCalls: Array<{ file: string; args: string[] }> = [];
  const runner: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    if (args.includes("pull")) {
      fs.writeFileSync(args[args.length - 1], "fake-mp4-bytes");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const spawner: ProcessSpawner = (file, args) => spawnCalls.push({ file, args });

  const opts = options({ runner, spawner });
  await runJob(opts);

  expect(spawnCalls).toHaveLength(1);
  expect(spawnCalls[0]).toEqual({
    file: "adb",
    args: ["-s", DEVICE, "shell", "screenrecord", "--time-limit", "180", "/sdcard/mdf-recording-3.mp4"],
  });

  const flowStep = repo.getSteps(opts.jobId).find((s) => s.kind === "flow");
  const artifacts = repo.getArtifacts(flowStep!.id);
  expect(artifacts.some((a) => a.kind === "recording")).toBe(true);
});

test("a pkill failure alone (recording already finalized, e.g. the >180s cap) is not recorded as a warning", async () => {
  // adb shell screenrecord exits on its own once it hits its time-limit cap,
  // so by the time the flow finishes, pkill matches no process and fails -
  // this is the expected, non-exceptional >180s case (recorder.ts's stop()
  // still pulls the finalized recording), not something worth warning an
  // operator about.
  const runner: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    if (args.includes("pkill")) return { code: 1, stdout: "", stderr: "no such process" };
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const opts = options({ runner, spawner: () => {} });
  await runJob(opts);

  const flowStep = repo.getSteps(opts.jobId).find((s) => s.kind === "flow");
  expect(flowStep!.status).toBe("passed");
  expect(flowStep!.warnings.some((w) => w.includes("screen recording"))).toBe(false);
});

test("a failed recording pull is recorded as a step warning, never fails the flow", async () => {
  const runner: CommandRunner = async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    if (args.includes("pull")) return { code: 1, stdout: "", stderr: "remote object does not exist" };
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const opts = options({ runner, spawner: () => {} });
  await runJob(opts);

  const flowStep = repo.getSteps(opts.jobId).find((s) => s.kind === "flow");
  expect(flowStep!.status).toBe("passed");
  expect(flowStep!.warnings.some((w) => w.includes("could not pull screen recording"))).toBe(true);
});

describe("reset policy threading", () => {
  /** Records every adb argv so the test can assert on what reached the phone. */
  function recordingRunner(calls: string[][]): CommandRunner {
    return async (file, args) => {
      calls.push([file, ...args]);
      if (file === "tar") return defaultRunner(file, args);
      if (args.includes("devices")) {
        return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
      }
      if (args.includes("resolve-activity")) {
        return { code: 0, stdout: "priority=0 isDefault=true\ncom.android.chrome/org.chromium.Main\n", stderr: "" };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    };
  }

  test("omitting the policy clears no browser", async () => {
    const calls: string[][] = [];
    await runJob(options({ runner: recordingRunner(calls) }));

    expect(calls.map((c) => c.join(" ")).some((c) => c.includes("pm clear com.android.chrome"))).toBe(false);
  });

  test("the device's policy reaches prepareDevice", async () => {
    const calls: string[][] = [];
    await runJob(options({ runner: recordingRunner(calls), resetPolicy: "app-and-browser" }));

    expect(calls.map((c) => c.join(" ")).some((c) => c.includes("pm clear com.android.chrome"))).toBe(true);
  });
});
