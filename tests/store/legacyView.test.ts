import { toLegacyJob } from "../../src/store/legacyView";
import type { JobRow, StepRow } from "../../src/store/rows";

const job: JobRow = {
  isolation: "disabled",
  requiredDeviceTags: [],
  id: "j1",
  org: "donable",
  status: "done",
  error: null,
  createdAt: 1700000000000,
  startedAt: 1700000001000,
  finishedAt: 1700000009000,
  envJson: null,
  deviceId: null,
  appId: null,
  appVersion: null,
};

function step(partial: Partial<StepRow> & Pick<StepRow, "ordinal" | "kind" | "name" | "status">): StepRow {
  return {
    id: partial.ordinal,
    jobId: "j1",
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    resolvedPath: null,
    artifactDir: null,
    warnings: [],
    stdoutPreview: null,
    stderrPreview: null,
    ...partial,
  } as StepRow;
}

const noOutput = () => ({ stdout: "", stderr: "" });

test("a passing job reports flows by name and results by resolved path", () => {
  const steps = [
    step({ ordinal: 0, kind: "setup", name: "device", status: "passed" }),
    step({ ordinal: 1, kind: "setup", name: "install", status: "passed" }),
    step({ ordinal: 2, kind: "setup", name: "extract", status: "passed" }),
    step({
      ordinal: 3,
      kind: "flow",
      name: "map/map",
      status: "passed",
      resolvedPath: "/tmp/x/e2e/scenarios/map/map.yaml",
    }),
  ];

  const legacy = toLegacyJob(job, steps, () => ({ stdout: "ok", stderr: "" }));

  expect(Object.keys(legacy).sort()).toEqual(
    ["createdAt", "flows", "id", "org", "results", "status"].sort()
  );
  expect(legacy.flows).toEqual(["map/map"]);
  expect(legacy.results).toEqual([
    { flow: "/tmp/x/e2e/scenarios/map/map.yaml", passed: true, stdout: "ok", stderr: "" },
  ]);
});

test("a failed setup step becomes the single angle-bracket result CI expects", () => {
  const steps = [
    step({
      ordinal: 0,
      kind: "setup",
      name: "device",
      status: "failed",
      stderrPreview: "device emulator-5554 is not present in `adb devices`",
    }),
    step({ ordinal: 1, kind: "setup", name: "install", status: "skipped" }),
    step({ ordinal: 2, kind: "setup", name: "extract", status: "skipped" }),
    step({ ordinal: 3, kind: "flow", name: "map/map", status: "skipped" }),
  ];

  const legacy = toLegacyJob(job, steps, (s) => ({ stdout: "", stderr: s.stderrPreview ?? "" }));

  expect(legacy.results).toHaveLength(1);
  expect(legacy.results[0].flow).toBe("<device>");
  expect(legacy.results[0].passed).toBe(false);
  expect(legacy.results[0].stderr).toContain("not present in `adb devices`");
});

test("successful setup steps never appear in results", () => {
  const steps = [
    step({ ordinal: 0, kind: "setup", name: "device", status: "passed" }),
    step({ ordinal: 1, kind: "setup", name: "install", status: "passed" }),
    step({ ordinal: 2, kind: "setup", name: "extract", status: "passed" }),
  ];

  expect(toLegacyJob(job, steps, noOutput).results).toEqual([]);
});

test("queued and skipped flows are omitted, so results grow as the run progresses", () => {
  const steps = [
    step({ ordinal: 0, kind: "setup", name: "device", status: "passed" }),
    step({ ordinal: 1, kind: "setup", name: "install", status: "passed" }),
    step({ ordinal: 2, kind: "setup", name: "extract", status: "passed" }),
    step({ ordinal: 3, kind: "flow", name: "a", status: "passed", resolvedPath: "/tmp/a.yaml" }),
    step({ ordinal: 4, kind: "flow", name: "b", status: "running" }),
    step({ ordinal: 5, kind: "flow", name: "c", status: "queued" }),
  ];

  const legacy = toLegacyJob({ ...job, status: "running" }, steps, noOutput);

  expect(legacy.results.map((r) => r.flow)).toEqual(["/tmp/a.yaml"]);
  expect(legacy.flows).toEqual(["a", "b", "c"]);
});

test("error is present only when the job has one", () => {
  const steps = [step({ ordinal: 0, kind: "setup", name: "device", status: "passed" })];

  expect("error" in toLegacyJob(job, steps, noOutput)).toBe(false);
  expect(toLegacyJob({ ...job, status: "failed", error: "boom" }, steps, noOutput).error).toBe("boom");
});

test("a flow with no resolved path falls back to its name", () => {
  const steps = [step({ ordinal: 3, kind: "flow", name: "map/map", status: "failed" })];

  expect(toLegacyJob(job, steps, noOutput).results[0].flow).toBe("map/map");
});
