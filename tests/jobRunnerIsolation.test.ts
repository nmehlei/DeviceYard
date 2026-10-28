import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { openDatabase, type Db } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { JobRepository } from "../src/store/jobRepository";
import { runJob, type RunJobOptions } from "../src/jobRunner";
import { defaultRunner, type CommandRunner } from "../src/maestro";
import { IsolationError, type IsolationHooks, type IsolationScope } from "../src/editions/isolation";
import type { IsolationMode } from "../shared/isolation";

const DEVICE = "emulator-5554";
const APP_ID = "net.donable.app.testing";
const FLOWS = ["map/map", "map/other"];
const PER_FLOW_INSTALL_STDOUT = "per-flow isolation: the APK is installed into each flow's work profile";
const TIMEOUT_STDERR = '[runner] "maestro" timed out after 900s and was killed';

let dir: string;
let dataDir: string;
let db: Db;
let repo: JobRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-isolation-runner-"));
  dataDir = path.join(dir, "data");
  db = openDatabase(path.join(dataDir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh apk, flows archive and extraction dir per job: runJob deletes all three when it ends. */
function inputs(): { apkPath: string; flowsArchivePath: string; extractDir: string } {
  const root = fs.mkdtempSync(path.join(dir, "job-"));
  const srcDir = path.join(root, "src");
  const scenarios = path.join(srcDir, "e2e", "scenarios", "map");
  fs.mkdirSync(scenarios, { recursive: true });
  for (const flow of FLOWS) {
    fs.writeFileSync(path.join(srcDir, "e2e", "scenarios", `${flow}.yaml`), "appId: test\n---\n- launchApp\n");
  }
  const flowsArchivePath = path.join(root, "flows.tar.gz");
  execFileSync("tar", ["-czf", flowsArchivePath, "-C", srcDir, "e2e"]);
  const apkPath = path.join(root, "app.apk");
  fs.writeFileSync(apkPath, "not-an-apk");
  return { apkPath, flowsArchivePath, extractDir: fs.mkdtempSync(path.join(root, "extract-")) };
}

type Respond = (file: string, args: string[]) => { code: number; stdout: string; stderr: string } | undefined;

/** Logs every command into the shared timeline; `respond` may override any non-tar answer. */
function fakeRunner(timeline: string[], respond: Respond = () => undefined): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    timeline.push([file, ...args].join(" "));
    const custom = respond(file, args);
    if (custom) return custom;
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

/** Hooks that record into the same timeline as the runner, so ordering across both is assertable. */
function fakeHooks(timeline: string[], overrides: Partial<IsolationHooks> = {}) {
  let nextUser = 10;
  const created: Array<{ jobId: string; ordinal?: number }> = [];
  const removed: IsolationScope[] = [];
  const hooks: IsolationHooks = {
    enabled: () => true,
    beforeJob: async (deviceId) => {
      timeline.push(`hook beforeJob ${deviceId}`);
      return [];
    },
    createScope: async (input) => {
      const userId = nextUser++;
      created.push({ jobId: input.jobId, ordinal: input.ordinal });
      timeline.push(`hook create ${userId}`);
      return { userId, name: `deviceyard-${input.jobId}`, warnings: [`scope warning ${userId}`], durationMs: 1234 };
    },
    removeScope: async (_deviceId, scope) => {
      removed.push(scope);
      timeline.push(`hook remove ${scope.userId}`);
      return [];
    },
    maestro: (scope) => ({ file: "maestro-fork", testArgs: ["--android-user", String(scope.userId)] }),
    ...overrides,
  };
  return { hooks, created, removed };
}

function options(
  timeline: string[],
  overrides: Partial<RunJobOptions> = {},
  mode: IsolationMode = "disabled"
): RunJobOptions {
  const job = repo.createJob("donable", FLOWS, undefined, null, null, undefined, [], mode);
  return {
    jobId: job.id,
    deviceId: DEVICE,
    appId: APP_ID,
    dataDir,
    ...inputs(),
    repo,
    runner: fakeRunner(timeline),
    spawner: () => {},
    captureScreenshot: async () => Buffer.from("png"),
    ...overrides,
  };
}

const steps = (jobId: string) => repo.getSteps(jobId);
const flowSteps = (jobId: string) => steps(jobId).filter((s) => s.kind === "flow");
const deviceStep = (jobId: string) => steps(jobId).find((s) => s.name === "device")!;
const commands = (timeline: string[], needle: string) => timeline.filter((c) => c.includes(needle));
const maestroRuns = (timeline: string[]) => timeline.filter((c) => /^maestro(-fork)? /.test(c));

test("a disabled job never calls createScope, and its install and Maestro argv match today's", async () => {
  // Today's behaviour, with no isolation option at all.
  const baseline: string[] = [];
  const plain = options(baseline, {});
  plain.runner = fakeRunner(baseline);
  await runJob(plain);

  const timeline: string[] = [];
  const { hooks, created } = fakeHooks(timeline);
  const disabled = options(timeline, {});
  disabled.runner = fakeRunner(timeline);
  disabled.isolation = { mode: "disabled", hooks };
  await runJob(disabled);

  const normalise = (cmds: string[], opts: RunJobOptions) =>
    cmds
      .filter((c) => !c.startsWith("hook "))
      .map((c) =>
        c
          .split(opts.apkPath).join("<apk>")
          .split(opts.extractDir).join("<extract>")
          .split(opts.jobId).join("<job>")
      );

  expect(created).toEqual([]);
  expect(normalise(timeline, disabled)).toEqual(normalise(baseline, plain));
  expect(commands(timeline, " install ")).toEqual([`adb -s ${DEVICE} install -r -d ${disabled.apkPath}`]);
  expect(maestroRuns(timeline).every((c) => c.startsWith("maestro --device") && !c.includes("--android-user"))).toBe(true);
  const shape = (jobId: string) => steps(jobId).map((s) => [s.name, s.status, s.warnings, s.profileMs]);
  expect(shape(disabled.jobId)).toEqual(shape(plain.jobId));
});

test("beforeJob warnings are recorded on the device step for every job", async () => {
  for (const mode of ["disabled", "per-job", "per-flow"] as const) {
    const timeline: string[] = [];
    const { hooks } = fakeHooks(timeline, {
      beforeJob: async () => ["removed leftover profile deviceyard-old"],
    });
    const opts = options(timeline, {}, mode);
    opts.isolation = { mode, hooks };
    await runJob(opts);

    expect(deviceStep(opts.jobId).warnings).toContain("removed leftover profile deviceyard-old");
  }
});

test("per-job creates one scope, installs into it, passes the user to every flow, and removes it once", async () => {
  const timeline: string[] = [];
  let observedAtRemoval: { status?: string; extractDirExists: boolean } | undefined;
  const opts = options(timeline, {}, "per-job");
  const { hooks, created } = fakeHooks(timeline, {
    removeScope: async (_d, scope) => {
      timeline.push(`hook remove ${scope.userId}`);
      observedAtRemoval = { status: repo.getJob(opts.jobId)?.status, extractDirExists: fs.existsSync(opts.extractDir) };
      return [];
    },
  });
  opts.isolation = { mode: "per-job", hooks };
  await runJob(opts);

  expect(created).toEqual([{ jobId: opts.jobId, ordinal: undefined }]);
  expect(timeline.filter((c) => c.startsWith("hook create") || c.startsWith("hook remove"))).toEqual([
    "hook create 10",
    "hook remove 10",
  ]);
  expect(commands(timeline, " install ")).toEqual([`adb -s ${DEVICE} install --user 10 -r -d ${opts.apkPath}`]);
  const runs = maestroRuns(timeline);
  expect(runs).toHaveLength(2);
  for (const run of runs) expect(run.startsWith(`maestro-fork --device ${DEVICE} test --android-user 10 `)).toBe(true);
  // Created before the install, removed after the last flow.
  expect(timeline.indexOf("hook create 10")).toBeLessThan(timeline.findIndex((c) => c.includes(" install ")));
  expect(timeline.indexOf("hook remove 10")).toBeGreaterThan(timeline.lastIndexOf(runs[1]));
  // Removed before cleanup and before the job turned terminal.
  expect(observedAtRemoval).toEqual({ status: "running", extractDirExists: true });
  expect(repo.getJob(opts.jobId)?.status).toBe("done");
  expect(steps(opts.jobId).every((s) => s.status === "passed")).toBe(true);
});

test("per-job records profile time on the device step", async () => {
  const timeline: string[] = [];
  const { hooks } = fakeHooks(timeline);
  const opts = options(timeline, {}, "per-job");
  opts.isolation = { mode: "per-job", hooks };
  await runJob(opts);

  const device = deviceStep(opts.jobId);
  expect(device.profileMs).toBe(1234);
  expect(device.warnings).toContain("scope warning 10");
  expect(flowSteps(opts.jobId).map((s) => s.profileMs)).toEqual([null, null]);
});

test("per-job removal warnings go to the last finished flow, or the device step if no flow ran", async () => {
  const timeline: string[] = [];
  const { hooks } = fakeHooks(timeline, { removeScope: async () => ["could not remove profile 10"] });
  const ran = options(timeline, {}, "per-job");
  ran.isolation = { mode: "per-job", hooks };
  await runJob(ran);
  const [, last] = flowSteps(ran.jobId);
  expect(last.warnings).toContain("could not remove profile 10");
  expect(last.stdoutPreview).toBe("ok");

  const installFails: CommandRunner = fakeRunner(timeline, (_f, args) =>
    args.includes("install") ? { code: 1, stdout: "", stderr: "INSTALL_FAILED_INSUFFICIENT_STORAGE" } : undefined
  );
  const none = options(timeline, { runner: installFails }, "per-job");
  none.isolation = { mode: "per-job", hooks };
  await runJob(none);
  const device = deviceStep(none.jobId);
  expect(device.warnings).toEqual(expect.arrayContaining(["scope warning 11", "could not remove profile 10"]));
  expect(device.profileMs).toBe(1234);
});

test("per-flow creates and removes one scope per flow, in order, and records profile time on each flow step", async () => {
  const timeline: string[] = [];
  const { hooks, created } = fakeHooks(timeline);
  const opts = options(timeline, {}, "per-flow");
  opts.isolation = { mode: "per-flow", hooks };
  await runJob(opts);

  const flows = flowSteps(opts.jobId);
  expect(created).toEqual(flows.map((s) => ({ jobId: opts.jobId, ordinal: s.ordinal })));
  const relevant = timeline
    .filter((c) => c.startsWith("hook create") || c.startsWith("hook remove") || c.includes(" install ") || /^maestro/.test(c))
    .map((c) => (c.startsWith("maestro") ? c.split(" test ")[0] + " test " + c.split(" test ")[1].split(" ").slice(0, 2).join(" ") : c));
  expect(relevant).toEqual([
    "hook create 10",
    `adb -s ${DEVICE} install --user 10 -r -d ${opts.apkPath}`,
    `maestro-fork --device ${DEVICE} test --android-user 10`,
    "hook remove 10",
    "hook create 11",
    `adb -s ${DEVICE} install --user 11 -r -d ${opts.apkPath}`,
    `maestro-fork --device ${DEVICE} test --android-user 11`,
    "hook remove 11",
  ]);

  const install = steps(opts.jobId).find((s) => s.name === "install")!;
  expect(install.status).toBe("passed");
  expect(install.stdoutPreview).toBe(PER_FLOW_INSTALL_STDOUT);
  expect(flows.map((s) => s.profileMs)).toEqual([1234, 1234]);
  expect(flows.map((s) => s.status)).toEqual(["passed", "passed"]);
  expect(flows[0].warnings).toContain("scope warning 10");
  expect(flows[1].warnings).toContain("scope warning 11");
  expect(deviceStep(opts.jobId).profileMs).toBeNull();
});

test("per-job removes the profile when a flow fails", async () => {
  const timeline: string[] = [];
  const { hooks, removed } = fakeHooks(timeline);
  const runner = fakeRunner(timeline, (file) => (file === "maestro-fork" ? { code: 1, stdout: "", stderr: "Assertion failed" } : undefined));
  const opts = options(timeline, { runner }, "per-job");
  opts.isolation = { mode: "per-job", hooks };
  await runJob(opts);

  expect(flowSteps(opts.jobId).map((s) => s.status)).toEqual(["failed", "failed"]);
  expect(removed.map((s) => s.userId)).toEqual([10]);
  expect(repo.getJob(opts.jobId)?.status).toBe("done");
});

test("per-job removes the profile when Maestro is killed by its timeout", async () => {
  const timeline: string[] = [];
  const { hooks, removed } = fakeHooks(timeline);
  const runner = fakeRunner(timeline, (file) => (file === "maestro-fork" ? { code: 1, stdout: "", stderr: TIMEOUT_STDERR } : undefined));
  const opts = options(timeline, { runner }, "per-job");
  opts.isolation = { mode: "per-job", hooks };
  await runJob(opts);

  expect(flowSteps(opts.jobId)[0].stderrPreview).toBe(TIMEOUT_STDERR);
  expect(removed.map((s) => s.userId)).toEqual([10]);
  expect(timeline[timeline.length - 1]).toBe("hook remove 10");
});

test("per-flow removes the flow's profile when Maestro is killed by its timeout", async () => {
  const timeline: string[] = [];
  const { hooks, removed } = fakeHooks(timeline);
  const runner = fakeRunner(timeline, (file) => (file === "maestro-fork" ? { code: 1, stdout: "", stderr: TIMEOUT_STDERR } : undefined));
  const opts = options(timeline, { runner }, "per-flow");
  opts.isolation = { mode: "per-flow", hooks };
  await runJob(opts);

  const [first] = flowSteps(opts.jobId);
  expect(first.status).toBe("failed");
  expect(first.stderrPreview).toBe(TIMEOUT_STDERR);
  expect(removed.map((s) => s.userId)).toContain(10);
  expect(timeline).toContain("hook remove 10");
});

test("per-job removes the profile when the job throws mid-run", async () => {
  const timeline: string[] = [];
  let statusAtRemoval: string | undefined;
  const opts = options(timeline, {}, "per-job");
  const { hooks, removed } = fakeHooks(timeline, {
    removeScope: async (_d, scope) => {
      removed.push(scope);
      statusAtRemoval = repo.getJob(opts.jobId)?.status;
      return [];
    },
  });
  opts.runner = fakeRunner(timeline, (file) => {
    if (file === "maestro-fork") throw new Error("maestro exploded");
    return undefined;
  });
  opts.isolation = { mode: "per-job", hooks };
  const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    await runJob(opts);
  } finally {
    errSpy.mockRestore();
  }

  expect(repo.getJob(opts.jobId)?.status).toBe("failed");
  expect(repo.getJob(opts.jobId)?.error).toContain("maestro exploded");
  expect(removed.map((s) => s.userId)).toEqual([10]);
  expect(statusAtRemoval).toBe("running");
});

test("a profile that cannot be created fails the device step with the adb output and runs no flow", async () => {
  const timeline: string[] = [];
  const { hooks, removed } = fakeHooks(timeline, {
    createScope: async () => {
      throw new IsolationError("could not create a work profile", "Error: couldn't create User.");
    },
  });
  const opts = options(timeline, {}, "per-job");
  opts.isolation = { mode: "per-job", hooks };
  await runJob(opts);

  const device = deviceStep(opts.jobId);
  expect(device.status).toBe("failed");
  expect(device.stderrPreview).toContain("could not create a work profile");
  expect(device.stderrPreview).toContain("Error: couldn't create User.");
  expect(steps(opts.jobId).slice(1).every((s) => s.status === "skipped")).toBe(true);
  expect(maestroRuns(timeline)).toEqual([]);
  expect(commands(timeline, " install ")).toEqual([]);
  expect(removed).toEqual([]);
  expect(repo.getJob(opts.jobId)?.status).toBe("done");
});

test("per-flow: a failed creation fails that flow, skips the rest, and creates nothing further", async () => {
  const timeline: string[] = [];
  let attempts = 0;
  const { hooks, removed } = fakeHooks(timeline, {
    createScope: async () => {
      attempts++;
      throw new IsolationError("could not create a work profile", "Error: couldn't create User.");
    },
  });
  const opts = options(timeline, {}, "per-flow");
  opts.isolation = { mode: "per-flow", hooks };
  await runJob(opts);

  const [first, second] = flowSteps(opts.jobId);
  expect(first.status).toBe("failed");
  expect(first.stderrPreview).toContain("could not create a work profile");
  expect(first.stderrPreview).toContain("Error: couldn't create User.");
  expect(second.status).toBe("skipped");
  expect(attempts).toBe(1);
  expect(removed).toEqual([]);
  expect(maestroRuns(timeline)).toEqual([]);
  expect(repo.getJob(opts.jobId)?.status).toBe("done");
});

test("per-flow: a failed install fails that flow, removes its profile, and skips the rest", async () => {
  const timeline: string[] = [];
  const { hooks, created, removed } = fakeHooks(timeline);
  const runner = fakeRunner(timeline, (_f, args) =>
    args.includes("install") ? { code: 1, stdout: "", stderr: "INSTALL_FAILED_USER_RESTRICTED" } : undefined
  );
  const opts = options(timeline, { runner }, "per-flow");
  opts.isolation = { mode: "per-flow", hooks };
  await runJob(opts);

  const [first, second] = flowSteps(opts.jobId);
  expect(first.status).toBe("failed");
  expect(first.stderrPreview).toContain("INSTALL_FAILED_USER_RESTRICTED");
  expect(first.profileMs).toBe(1234);
  expect(second.status).toBe("skipped");
  expect(created).toHaveLength(1);
  expect(removed.map((s) => s.userId)).toEqual([10]);
  expect(maestroRuns(timeline)).toEqual([]);
});

test("per-flow: a failed removal is a warning and the next flow still runs", async () => {
  const timeline: string[] = [];
  const { hooks, created } = fakeHooks(timeline, {
    removeScope: async (_d, scope) => (scope.userId === 10 ? ["could not remove profile 10"] : []),
  });
  const opts = options(timeline, {}, "per-flow");
  opts.isolation = { mode: "per-flow", hooks };
  await runJob(opts);

  const [first, second] = flowSteps(opts.jobId);
  expect(first.status).toBe("passed");
  expect(first.warnings).toContain("could not remove profile 10");
  expect(second.status).toBe("passed");
  expect(created).toHaveLength(2);
  expect(maestroRuns(timeline)).toHaveLength(2);
});

test("an isolated job without hooks fails the device step with a clear message", async () => {
  const timeline: string[] = [];
  const opts = options(timeline, {}, "per-job");
  opts.isolation = { mode: "per-job" };
  await runJob(opts);

  const device = deviceStep(opts.jobId);
  expect(device.status).toBe("failed");
  expect(device.stderrPreview).toBe('isolation "per-job" requires an active DeviceYard Pro license');
  expect(steps(opts.jobId).slice(1).every((s) => s.status === "skipped")).toBe(true);
  expect(maestroRuns(timeline)).toEqual([]);
});
