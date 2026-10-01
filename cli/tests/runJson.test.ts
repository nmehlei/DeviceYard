import { renderRunJson } from "../src/report/json";
import type { JobDetail } from "../../shared/apiTypes";

const detail = {
  job: { id: "job-1", org: "o", status: "done", error: null, createdAt: 0, startedAt: 0, finishedAt: 0 },
  steps: [
    { id: 1, jobId: "job-1", ordinal: 0, kind: "flow", name: "login", status: "passed",
      exitCode: 0, startedAt: 1000, finishedAt: 3500, resolvedPath: null, artifactDir: null,
      warnings: [], stdoutPreview: null, stderrPreview: null },
    { id: 2, jobId: "job-1", ordinal: 1, kind: "setup", name: "<install>", status: "passed",
      exitCode: 0, startedAt: null, finishedAt: null, resolvedPath: null, artifactDir: null,
      warnings: [], stdoutPreview: null, stderrPreview: null },
  ],
} as unknown as JobDetail;

describe("renderRunJson", () => {
  it("emits a shape the CLI owns, not a mirror of the API", () => {
    expect(JSON.parse(renderRunJson("job-1", "https://f.example", detail))).toEqual({
      jobId: "job-1",
      farmUrl: "https://f.example",
      status: "done",
      flows: [{ name: "login", status: "passed", durationMs: 2500 }],
    });
  });

  it("excludes setup steps, so a consumer counting flows is not misled", () => {
    expect(renderRunJson("job-1", "https://f.example", detail)).not.toContain("install");
  });

  it("reports a null duration rather than 0 for a step that never started", () => {
    const d = JSON.parse(JSON.stringify(detail));
    d.steps[0].startedAt = null;
    expect(JSON.parse(renderRunJson("job-1", "u", d)).flows[0].durationMs).toBeNull();
  });

  it("ends with a newline, so it appends cleanly to a log", () => {
    expect(renderRunJson("job-1", "u", detail).endsWith("\n")).toBe(true);
  });
});
