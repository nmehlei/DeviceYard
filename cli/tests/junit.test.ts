import { renderJUnit } from "../src/report/junit";
import type { StepRow } from "../../shared/apiTypes";

const step = (over: Partial<StepRow>): StepRow => ({
  id: 1, jobId: "job-1", ordinal: 0, kind: "flow", name: "login", status: "passed",
  exitCode: 0, startedAt: 1000, finishedAt: 3500, resolvedPath: null, artifactDir: null,
  warnings: [], stdoutPreview: null, stderrPreview: null, artifacts: [],
  ...over,
} as StepRow);

describe("renderJUnit", () => {
  it("emits one testcase per flow step with seconds, not milliseconds", () => {
    const xml = renderJUnit("job-1", [step({})]);
    expect(xml).toContain('<testcase name="login"');
    expect(xml).toContain('time="2.5"');
  });

  it("marks a failed step with a <failure> element carrying its output", () => {
    const xml = renderJUnit("job-1", [step({ status: "failed", stderrPreview: "element not found" })]);
    expect(xml).toContain("<failure");
    expect(xml).toContain("element not found");
  });

  it("falls back to stdout when there is no stderr", () => {
    const xml = renderJUnit("job-1", [step({ status: "failed", stdoutPreview: "assertion failed" })]);
    expect(xml).toContain("assertion failed");
  });

  it("marks a skipped step with <skipped/>", () => {
    expect(renderJUnit("job-1", [step({ status: "skipped" })])).toContain("<skipped/>");
  });

  it("escapes XML metacharacters in names and output", () => {
    const xml = renderJUnit("job-1", [step({ name: "a&b<c>", status: "failed", stderrPreview: 'say "hi" & <bye>' })]);
    expect(xml).toContain("a&amp;b&lt;c&gt;");
    expect(xml).not.toContain("<bye>");
  });

  it("excludes setup steps - they are infrastructure, not tests", () => {
    const xml = renderJUnit("job-1", [step({ kind: "setup", name: "<install>" })]);
    expect(xml).not.toContain("install");
    expect(xml).toContain('tests="0"');
  });

  it("counts failures and skips in the testsuite attributes", () => {
    const xml = renderJUnit("job-1", [
      step({ id: 1, name: "a", status: "passed" }),
      step({ id: 2, name: "b", status: "failed" }),
      step({ id: 3, name: "c", status: "skipped" }),
    ]);
    expect(xml).toContain('tests="3"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('skipped="1"');
  });

  it("reports 0 seconds for a step that never started", () => {
    expect(renderJUnit("job-1", [step({ startedAt: null, finishedAt: null })])).toContain('time="0"');
  });
});
