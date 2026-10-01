import { tail, formatJobDetail, formatJobList } from "../../src/mcp/format";
import type { JobDetail, JobSummary, StepRow } from "../../src/mcp/apiTypes";

describe("tail", () => {
  it("returns short text unchanged and unmarked", () => {
    expect(tail("one\ntwo")).toBe("one\ntwo");
  });

  it("keeps the LAST 100 lines, because the failure is at the end", () => {
    const out = tail(Array.from({ length: 150 }, (_, i) => `line${i}`).join("\n"));
    expect(out).toContain("line149");
    expect(out).not.toContain("line49");
    expect(out).toContain("truncated");
  });

  it("also caps by characters for a log with few but enormous lines", () => {
    const out = tail("x".repeat(20000));
    expect(out.length).toBeLessThan(9000);
    expect(out).toContain("truncated");
  });
});

const T0 = Date.parse("2026-09-01T10:00:00.000Z");

function step(over: Partial<StepRow>): StepRow {
  return {
    id: 1,
    jobId: "job-1",
    ordinal: 0,
    kind: "flow",
    name: "map",
    status: "passed",
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    resolvedPath: null,
    artifactDir: null,
    warnings: [],
    stdoutPreview: null,
    stderrPreview: null,
    ...over,
  };
}

const detail = (over: Partial<JobDetail> = {}): JobDetail => ({
  job: {
    id: "job-1",
    org: "donable",
    status: "done" as JobDetail["job"]["status"],
    error: null,
    createdAt: T0,
    startedAt: T0,
    finishedAt: T0 + 20000,
    appId: null,
    appVersion: null,
  },
  steps: [
    step({
      id: 1,
      ordinal: 0,
      name: "map",
      status: "passed",
      startedAt: T0 + 1000,
      finishedAt: T0 + 11000,
    }),
    step({
      id: 2,
      ordinal: 1,
      name: "map/filter",
      status: "failed",
      exitCode: 1,
      startedAt: T0 + 11000,
      finishedAt: T0 + 21000,
      artifacts: [
        { id: 7, flowRunId: 2, kind: "screenshot", relPath: "job-1/1/a.png", bytes: 100, createdAt: T0 },
        { id: 8, flowRunId: 2, kind: "log", relPath: "job-1/1/maestro.log", bytes: 50, createdAt: T0 },
      ],
    }),
  ],
  ...over,
});

describe("formatJobDetail", () => {
  it("leads with the job id and status", () => {
    expect(formatJobDetail(detail())).toMatch(/^job job-1 .*done/m);
  });

  it("renders timestamps as ISO strings, not raw epoch numbers", () => {
    const out = formatJobDetail(detail());
    expect(out).toContain(new Date(T0).toISOString());
    expect(out).not.toContain(String(T0));
  });

  it("marks pass and fail per flow with whole-second durations", () => {
    const out = formatJobDetail(detail());
    expect(out).toContain("PASS  map");
    expect(out).toContain("FAIL  map/filter");
    expect(out).toContain("10s");
  });

  it("marks a setup step distinctly and excludes it from the flow tally", () => {
    const out = formatJobDetail(
      detail({
        steps: [
          step({ id: 3, ordinal: 0, kind: "setup", name: "install apk", status: "passed" }),
          step({ id: 1, ordinal: 1, kind: "flow", name: "map", status: "passed" }),
        ],
      }),
    );
    expect(out).toContain("[setup] install apk");
    expect(out).toContain("1 passed, 0 failed, 1 flows");
  });

  it("shows the exit code for a failed step", () => {
    const out = formatJobDetail(detail());
    expect(out).toContain("exit code 1");
  });

  it("lists artifact ids and kinds so get_artifact has something to ask for", () => {
    const out = formatJobDetail(detail());
    expect(out).toContain("id 7");
    expect(out).toContain("screenshot");
    expect(out).toContain("id 8");
  });

  it("surfaces a runner-level error distinctly from a test failure", () => {
    const out = formatJobDetail(
      detail({
        job: {
          id: "job-1",
          org: "d",
          status: "failed",
          error: "adb offline",
          createdAt: T0,
          startedAt: T0,
          finishedAt: null,
          appId: null,
          appVersion: null,
        },
      }),
    );
    expect(out).toContain("runner error: adb offline");
  });

  it("says so plainly when a job has no steps yet", () => {
    const out = formatJobDetail(detail({ steps: [] }));
    expect(out).toContain("no steps");
  });
});

describe("formatJobList", () => {
  it("renders one line per job with its progress counts", () => {
    const jobs: JobSummary[] = [
      {
        id: "job-1",
        org: "d",
        status: "running",
        error: null,
        createdAt: T0,
        startedAt: T0,
        finishedAt: null,
        appId: null,
        appVersion: null,
        flowCount: 10,
        passed: 3,
        failed: 1,
        running: 1,
      },
    ];
    const out = formatJobList(jobs);
    expect(out).toContain("job-1");
    expect(out).toContain("3 passed");
    expect(out).toContain("1 failed");
  });

  it("says so when there are none, rather than returning empty content", () => {
    expect(formatJobList([])).toContain("no jobs");
  });
});
