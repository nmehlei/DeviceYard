import fs from "fs";
import os from "os";
import path from "path";
import { runStatus, runList, runArtifacts } from "../src/commands/reads";
import { EXIT_OK, EXIT_ERROR, EXIT_FLOW_FAILED } from "../src/exit";
import type { FarmClient } from "../../shared/client";
import type { Io } from "../src/main";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const i: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: {} };
  return { io: i, out, err };
}

const step = (over: Record<string, unknown>) => ({
  id: 1, jobId: "job-1", ordinal: 0, kind: "flow", name: "login", status: "passed",
  exitCode: 0, startedAt: 1000, finishedAt: 3000, resolvedPath: null, artifactDir: null,
  warnings: [], stdoutPreview: null, stderrPreview: null, artifacts: [], ...over,
});

function client(json: unknown, binary = Buffer.from("png")) {
  const fetched: string[] = [];
  // Records the path. A fake that answers ANY route cannot show that the
  // WRONG route was called - which is exactly how the whoami bug reached a
  // live farm: every test passed while the command hit a person-scoped
  // endpoint with an org token.
  const asked: string[] = [];
  const c: FarmClient = {
    async getJson(p: string) { asked.push(p); return json as never; },
    async getBinary(p: string) {
      fetched.push(p);
      return { bytes: binary, contentType: "image/png", totalBytes: binary.length, partial: false };
    },
    async postForm() { throw new Error("not used"); },
    async openEvents() { throw new Error("not used"); },
  };
  return Object.assign(c, { fetched, asked });
}

describe("runStatus", () => {
  it("prints one line per step and exits 0 when all passed", async () => {
    const { io: i, out } = io();
    const c = client({ job: { id: "job-1", status: "done" }, steps: [step({})] });
    expect(await runStatus("job-1", c, i)).toBe(EXIT_OK);
    expect(c.asked).toEqual(["/api/jobs/job-1"]);
    expect(out.join("\n")).toContain("login");
    expect(out.join("\n")).toContain("passed");
  });

  it("exits 2 when a flow failed", async () => {
    const { io: i } = io();
    const c = client({ job: { id: "job-1", status: "done" }, steps: [step({ status: "failed" })] });
    expect(await runStatus("job-1", c, i)).toBe(EXIT_FLOW_FAILED);
  });

  it("exits 1 when the job failed before any flow ran", async () => {
    const { io: i, err } = io();
    const c = client({ job: { id: "job-1", status: "failed", error: "no active device" }, steps: [] });
    expect(await runStatus("job-1", c, i)).toBe(EXIT_ERROR);
    expect(err.join("\n")).toContain("no active device");
  });

  it("marks setup steps so they are not mistaken for flows", async () => {
    const { io: i, out } = io();
    const c = client({ job: { id: "job-1", status: "done" }, steps: [step({ kind: "setup", name: "<install>" })] });
    await runStatus("job-1", c, i);
    expect(out.join("\n")).toContain("[setup]");
  });
});

describe("runList", () => {
  it("prints one line per job with its progress counts", async () => {
    const { io: i, out } = io();
    const c = client({ jobs: [{ id: "job-2", status: "done", createdAt: 0, flowCount: 3, passed: 2, failed: 1, running: 0 }] });
    expect(await runList(10, c, i)).toBe(EXIT_OK);
    expect(c.asked).toEqual(["/api/jobs?limit=10"]);
    expect(out.join("\n")).toMatch(/job-2.*2\/3/);
  });

  it("says so plainly when there are no jobs", async () => {
    const { io: i, out } = io();
    expect(await runList(10, client({ jobs: [] }), i)).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("no jobs");
  });
});

describe("runArtifacts", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dy-art-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const detail = {
    job: { id: "job-1", status: "done" },
    steps: [
      step({ id: 1, name: "login", status: "passed", artifacts: [{ id: 10, flowRunId: 1, kind: "screenshot", relPath: "a.png", bytes: 3, createdAt: 0 }] }),
      step({ id: 2, name: "map/filter", status: "failed", artifacts: [{ id: 20, flowRunId: 2, kind: "screenshot", relPath: "b.png", bytes: 3, createdAt: 0 }] }),
    ],
  };

  it("downloads every artifact for ALL", async () => {
    const c = client(detail);
    expect(await runArtifacts("job-1", "ALL", path.join(dir, "out"), c, io().io)).toBe(EXIT_OK);
    expect(c.asked).toEqual(["/api/jobs/job-1"]);
    expect(c.fetched).toEqual(["/api/artifacts/10", "/api/artifacts/20"]);
  });

  it("downloads only failed steps' artifacts for FAILED", async () => {
    const c = client(detail);
    await runArtifacts("job-1", "FAILED", path.join(dir, "out"), c, io().io);
    expect(c.fetched).toEqual(["/api/artifacts/20"]);
  });

  it("writes files under <out>/<step name>/<relPath>, with the step name path-safe", async () => {
    await runArtifacts("job-1", "FAILED", path.join(dir, "out"), client(detail), io().io);
    expect(fs.existsSync(path.join(dir, "out", "map_filter", "b.png"))).toBe(true);
  });

  it("exits 1 with a readable message when there is nothing to download", async () => {
    const { io: i, err } = io();
    const empty = { job: { id: "job-1", status: "done" }, steps: [step({ artifacts: [] })] };
    expect(await runArtifacts("job-1", "ALL", path.join(dir, "out"), client(empty), i)).toBe(EXIT_ERROR);
    expect(err.join("\n")).toContain("no artifacts");
  });
});
