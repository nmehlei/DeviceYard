import { jobOutcome, durationLabel } from "../../src/lib/jobPresentation";
import type { JobDetail, StepWithArtifacts } from "../../src/lib/api";
const flow: StepWithArtifacts = { id: 1, jobId: "j", kind: "flow", name: "test", ordinal: 0, status: "passed", exitCode: 0, startedAt: 0, finishedAt: 1000, resolvedPath: null, artifactDir: null, artifacts: [], warnings: [], stdoutPreview: null, stderrPreview: null };
const detail: JobDetail = { job: { id: "j", org: "o", status: "done", error: null, createdAt: 0, startedAt: 0, finishedAt: 1000, deviceId: null, appId: null, appVersion: null }, steps: [flow] };
test("completed execution with a failed flow is a failed result", () => {
  expect(jobOutcome({ ...detail, steps: [{ ...flow, status: "failed" }] }).title).toBe("Job failed");
});
test("setup does not inflate flow counts and setup failures prevent success", () => {
  const outcome = jobOutcome({ ...detail, steps: [flow, { ...flow, id: 2, kind: "setup", status: "failed" }] });
  expect(outcome.title).toBe("Job failed");
  expect(outcome.counts).toEqual({ passed: 1, failed: 0, queued: 0, running: 0, skipped: 0 });
});
test("only all-passed flows earn a passed outcome", () => {
  expect(jobOutcome(detail).title).toBe("All flows passed");
  expect(jobOutcome({ ...detail, steps: [] }).title).toBe("Completed — no flows ran");
  expect(jobOutcome({ ...detail, steps: [{ ...flow, status: "skipped" }] }).title).toBe("Completed");
  expect(jobOutcome({ ...detail, job: { ...detail.job, status: "running" } }).title).toBe("Running flows");
});
test("duration handles missing timestamps and epoch zero", () => {
  expect(durationLabel(null, 1000)).toBe("—");
  expect(durationLabel(0, 102000)).toBe("1m 42s");
});
