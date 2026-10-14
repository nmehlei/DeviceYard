import fs from "fs";
import os from "os";
import path from "path";
import { runCloud, type CloudDeps } from "../src/commands/cloud";
import { parseCloud } from "../src/args";
import { EXIT_OK, EXIT_ERROR, EXIT_FLOW_FAILED } from "../src/exit";
import { FarmError, type FarmClient } from "../../shared/client";
import type { Io } from "../src/main";

const e2e = path.join(__dirname, "fixtures", "repo", "e2e");
const scenarios = path.join(e2e, "scenarios");
const conn = { farmUrl: "https://f.example", timeoutMs: 1000, token: "t", kind: "org" as const };

let apk: string;
let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dy-cloud-"));
  apk = path.join(tmpDir, "app.apk");
  fs.writeFileSync(apk, "not-a-real-apk");
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const step = (over: Record<string, unknown>) => ({
  id: 1, jobId: "job-1", ordinal: 0, kind: "flow", name: "login", status: "passed",
  exitCode: 0, startedAt: 1000, finishedAt: 3000, resolvedPath: null, artifactDir: null,
  warnings: [], stdoutPreview: null, stderrPreview: null, artifacts: [], ...over,
});

const frame = (status: string, steps: Array<Record<string, unknown>>) => ({
  job: { id: "job-1", org: "o", status, error: null, createdAt: 0, startedAt: 0, finishedAt: 0 },
  steps: steps.map((s, i) => step({ id: i, ordinal: i, ...s })),
});

function deps(frames: unknown[], postResult: unknown = { id: "job-1", status: "queued" }) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: {} };
  // Every route the CLI asks for is recorded. A fake that answers ANY path
  // cannot show that the WRONG path was called - which is how the whoami bug
  // reached a live farm with a full green suite behind it.
  const asked: string[] = [];
  const client: FarmClient = {
    async getJson(p) { asked.push(p); return frames[frames.length - 1] as never; },
    async getBinary(p) { asked.push(p); throw new Error("not used"); },
    async postForm(p) { asked.push(p); return postResult as never; },
    async openEvents(p, onFrame) { asked.push(p); for (const f of frames) onFrame(f); },
  };
  return { client, io, now: () => 0, out, err, asked } as CloudDeps & {
    out: string[]; err: string[]; asked: string[];
  };
}

describe("runCloud", () => {
  it('serializes device requirements separately from flow tags', async () => {
    const d = deps([]);
    let posted: FormData | undefined;
    d.client.postForm = async (_url, form) => { posted = form; return {id:'job-1',status:'queued'}; };
    expect(await runCloud(parseCloud([apk, scenarios, '--device-tags', 'tablet,camera', '--async']),conn,d)).toBe(EXIT_OK);
    expect(posted?.get('requiredDeviceTags')).toBe('["tablet","camera"]');
    expect(() => parseCloud([apk,scenarios,'--device-tags','Tablet'])).toThrow();
    expect(() => parseCloud([apk,scenarios,'--device-tags','tablet,'])).toThrow();
  });
  it("exits 0 when every flow passes", async () => {
    const d = deps([frame("done", [{ name: "login", status: "passed" }, { name: "map/filter", status: "passed" }])]);
    expect(await runCloud(parseCloud([apk, scenarios]), conn, d)).toBe(EXIT_OK);
    // Submits to the frozen CI route and streams the dashboard SSE route -
    // and nothing else.
    expect(d.asked).toEqual(["/run", "/api/jobs/job-1/events"]);
  });

  it("exits 2 when a flow fails", async () => {
    const d = deps([frame("done", [{ name: "login", status: "failed" }, { name: "map/filter", status: "passed" }])]);
    expect(await runCloud(parseCloud([apk, scenarios]), conn, d)).toBe(EXIT_FLOW_FAILED);
  });

  it("exits 1 - not 2 - when the job fails in setup", async () => {
    // A setup failure is infrastructure, not a test verdict. A pipeline must
    // not retry it as if a test had flaked.
    const d = deps([{
      job: { id: "job-1", org: "o", status: "failed", error: "no active device", createdAt: 0, startedAt: null, finishedAt: null },
      steps: [],
    }]);
    expect(await runCloud(parseCloud([apk, scenarios]), conn, d)).toBe(EXIT_ERROR);
    expect(d.err.join("\n")).toContain("no active device");
  });

  it("exits 0 immediately with the job id under --async, without streaming", async () => {
    const d = deps([]);
    let streamed = false;
    d.client.openEvents = async () => { streamed = true; };
    expect(await runCloud(parseCloud([apk, scenarios, "--async"]), conn, d)).toBe(EXIT_OK);
    expect(streamed).toBe(false);
    expect(d.out).toEqual(["job-1"]);
  });

  it("uploads nothing under --dry-run and lists the resolved flows with their tags", async () => {
    const d = deps([]);
    let posted = false;
    d.client.postForm = async () => { posted = true; return {} as never; };
    expect(await runCloud(parseCloud([apk, scenarios, "--dry-run"]), conn, d)).toBe(EXIT_OK);
    expect(posted).toBe(false);
    const text = d.out.join("\n");
    expect(text).toContain("login");
    expect(text).toContain("map/filter");
    expect(text).toContain("smoke");
  });

  it("applies --include-tags before submitting", async () => {
    const d = deps([]);
    let submitted: string | undefined;
    d.client.postForm = async (_p, form) => {
      submitted = form.get("flows") as string;
      return { id: "job-1", status: "queued" } as never;
    };
    await runCloud(parseCloud([apk, scenarios, "--include-tags", "smoke", "--async"]), conn, d);
    expect(JSON.parse(submitted!)).toEqual(["login"]);
  });

  it("sends env as a JSON object only when --env was given", async () => {
    const d = deps([]);
    let form: FormData | undefined;
    d.client.postForm = async (_p, f) => { form = f; return { id: "job-1", status: "queued" } as never; };

    await runCloud(parseCloud([apk, scenarios, "--async"]), conn, d);
    expect(form!.get("env")).toBeNull();

    await runCloud(parseCloud([apk, scenarios, "--async", "--env", "A=1"]), conn, d);
    expect(JSON.parse(form!.get("env") as string)).toEqual({ A: "1" });
  });

  it("exits 1 and surfaces the farm's own reason on an auth failure", async () => {
    const d = deps([]);
    d.client.postForm = async () => {
      throw new FarmError("the farm rejected the credential (HTTP 403): not a member of that org", "auth", 403);
    };
    expect(await runCloud(parseCloud([apk, scenarios]), conn, d)).toBe(EXIT_ERROR);
    expect(d.err.join("\n")).toContain("not a member of that org");
  });

  it("exits 1 when the app file does not exist", async () => {
    const d = deps([]);
    expect(await runCloud(parseCloud(["/nope/app.apk", scenarios]), conn, d)).toBe(EXIT_ERROR);
    expect(d.err.join("\n")).toContain("no such app file");
  });

  it("prints each step once under a repeating stream, and never under --quiet", async () => {
    const frames = [
      frame("running", [{ name: "login", status: "running" }]),
      frame("running", [{ name: "login", status: "running" }]),
      frame("done", [{ name: "login", status: "passed" }]),
    ];
    const loud = deps(frames);
    await runCloud(parseCloud([apk, scenarios]), conn, loud);
    expect(loud.out.filter((l) => l.includes("login")).length).toBe(2); // running, then passed

    const quiet = deps(frames);
    await runCloud(parseCloud([apk, scenarios, "--quiet"]), conn, quiet);
    expect(quiet.out.filter((l) => l.startsWith("PASS") || l.startsWith("...."))).toEqual([]);
  });

  it("writes a JUnit report to --junit-path", async () => {
    const out = path.join(tmpDir, "report.xml");
    const d = deps([frame("done", [{ name: "login", status: "passed" }])]);
    await runCloud(parseCloud([apk, scenarios, "--report", "junit", "--junit-path", out]), conn, d);
    expect(fs.readFileSync(out, "utf8")).toContain('<testcase name="login"');
  });

  it("writes --json-file and still exits 0 on a flow failure", async () => {
    const out = path.join(tmpDir, "result.json");
    const d = deps([frame("done", [{ name: "login", status: "failed" }])]);
    const code = await runCloud(
      parseCloud([apk, scenarios, "--json-file", "--json-file-name", out]), conn, d,
    );
    // The caller said it would read the file itself; do not also fail the build.
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).flows[0].status).toBe("failed");
  });

  it("still exits 2 on a flow failure under --json", async () => {
    const d = deps([frame("done", [{ name: "login", status: "failed" }])]);
    expect(await runCloud(parseCloud([apk, scenarios, "--json"]), conn, d)).toBe(EXIT_FLOW_FAILED);
    expect(d.out.join("\n")).toContain('"status": "failed"');
  });

  it("keeps the flows' verdict when the artifact download fails", async () => {
    const d = deps([frame("done", [{ name: "login", status: "passed" }])]);
    d.client.getJson = async () => { throw new Error("artifact listing exploded"); };
    const code = await runCloud(
      parseCloud([apk, scenarios, "--download-artifacts", "ALL", "--artifacts-path", path.join(tmpDir, "a")]),
      conn, d,
    );
    expect(code).toBe(EXIT_OK);
    expect(d.err.join("\n")).toContain("artifact download failed");
  });

  it("polls to a verdict when the event stream drops mid-run", async () => {
    // Observed live: the job queued behind an 11-flow run, the SSE connection
    // through the reverse proxy dropped, and the CLI exited 1 on a job that
    // was still perfectly healthy. A dropped stream is not a failed job.
    const d = deps([]);
    d.client.openEvents = async () => {
      throw new FarmError("could not reach the farm: The socket connection was closed unexpectedly", "unreachable");
    };
    let polls = 0;
    d.client.getJson = async () => {
      polls += 1;
      // Still queued the first time, finished the second.
      return (polls === 1
        ? { job: { id: "job-1", status: "queued", error: null, createdAt: 0 }, steps: [] }
        : frame("done", [{ name: "login", status: "passed" }])) as never;
    };
    const code = await runCloud(parseCloud([apk, scenarios]), conn, d);
    expect(code).toBe(EXIT_OK);
    expect(polls).toBeGreaterThan(1);
    expect(d.err.join("\n")).toContain("polling instead");
  }, 30000);

  it("still reports a real flow failure found by polling", async () => {
    const d = deps([]);
    d.client.openEvents = async () => { throw new FarmError("stream gone", "unreachable"); };
    d.client.getJson = async () => frame("done", [{ name: "login", status: "failed" }]) as never;
    expect(await runCloud(parseCloud([apk, scenarios]), conn, d)).toBe(EXIT_FLOW_FAILED);
  }, 30000);

  it("gives up with the job id when the wait budget runs out", async () => {
    const d = deps([]);
    d.io.env = { DEVICEYARD_WAIT_MS: "1" };
    d.client.openEvents = async () => { throw new FarmError("stream gone", "unreachable"); };
    d.client.getJson = async () =>
      ({ job: { id: "job-1", status: "queued", error: null, createdAt: 0 }, steps: [] }) as never;
    expect(await runCloud(parseCloud([apk, scenarios]), conn, d)).toBe(EXIT_ERROR);
    // Must hand back the id, or the run is simply lost.
    expect(d.err.join("\n")).toContain("job-1");
    expect(d.err.join("\n")).toContain("deviceyard status");
  }, 30000);

  describe("announcing the job's own status while waiting", () => {
    // Build 2395: a job queued 2h41m behind a 31-flow run produced identical
    // silence to a genuine CLI hang, and the wrapper killed it looking like a
    // regression of the poll-timeout fix. Nothing here was ever "hung" - the
    // CLI just had nothing to say about a job with no steps yet.
    it("says the job is queued before it starts running, even while polling", async () => {
      const d = deps([]);
      d.io.env = { DEVICEYARD_POLL_INTERVAL_MS: "1" };
      d.client.openEvents = async () => { throw new FarmError("stream gone", "unreachable"); };
      let calls = 0;
      d.client.getJson = (async () => {
        calls += 1;
        return calls === 1
          ? { job: { id: "job-1", status: "queued", error: null, createdAt: 0 }, steps: [] }
          : frame("done", [{ name: "login", status: "passed" }]);
      }) as never;
      await runCloud(parseCloud([apk, scenarios]), conn, d);
      expect(d.out.some((l) => l.toLowerCase().includes("queued"))).toBe(true);
    });

    it("says nothing extra when the job is already running - the step lines cover it", async () => {
      const d = deps([frame("running", [{ name: "login", status: "running" }])]);
      d.client.openEvents = async (_p, onFrame) => {
        onFrame({ job: { id: "job-1", status: "running", error: null, createdAt: 0 }, steps: [] });
        onFrame(frame("done", [{ name: "login", status: "passed" }]));
      };
      await runCloud(parseCloud([apk, scenarios]), conn, d);
      expect(d.out.some((l) => l.toLowerCase().includes("queued"))).toBe(false);
    });

    it("stays silent under --quiet", async () => {
      const d = deps([]);
      d.io.env = { DEVICEYARD_POLL_INTERVAL_MS: "1" };
      d.client.openEvents = async () => { throw new FarmError("stream gone", "unreachable"); };
      let calls = 0;
      d.client.getJson = (async () => {
        calls += 1;
        return calls === 1
          ? { job: { id: "job-1", status: "queued", error: null, createdAt: 0 }, steps: [] }
          : frame("done", [{ name: "login", status: "passed" }]);
      }) as never;
      await runCloud(parseCloud([apk, scenarios, "--quiet"]), conn, d);
      expect(d.out.some((l) => l.toLowerCase().includes("queued"))).toBe(false);
    });
  });

  describe("when polling after the stream drops", () => {
    // Build 2373: the job had already finished when the stream dropped, and the
    // first poll request then stalled for the full 15-minute default timeout -
    // longer than the pipeline's own job limit, so the CLI's timeout could
    // never fire first.
    const droppedStream = (d: ReturnType<typeof deps>) => {
      d.io.env = { DEVICEYARD_POLL_INTERVAL_MS: "1" };
      d.client.openEvents = async () => { throw new FarmError("stream gone", "unreachable"); };
    };

    it("bounds each poll request well below the client default", async () => {
      const d = deps([]);
      droppedStream(d);
      const seen: Array<number | undefined> = [];
      d.client.getJson = (async (_p: string, o?: { timeoutMs?: number }) => {
        seen.push(o?.timeoutMs);
        return frame("done", [{ name: "login", status: "passed" }]);
      }) as never;
      await runCloud(parseCloud([apk, scenarios]), { ...conn, timeoutMs: 900_000 }, d);
      expect(seen[0]).toBeDefined();
      expect(seen[0]!).toBeLessThanOrEqual(30_000);
    });

    it("never asks for longer than the user's own --timeout", async () => {
      const d = deps([]);
      droppedStream(d);
      let asked: number | undefined;
      d.client.getJson = (async (_p: string, o?: { timeoutMs?: number }) => {
        asked = o?.timeoutMs;
        return frame("done", [{ name: "login", status: "passed" }]);
      }) as never;
      await runCloud(parseCloud([apk, scenarios]), { ...conn, timeoutMs: 2_000 }, d);
      expect(asked).toBe(2_000);
    });

    it("rides out transient poll failures and still reports the real verdict", async () => {
      const d = deps([]);
      droppedStream(d);
      let calls = 0;
      d.client.getJson = (async () => {
        calls += 1;
        if (calls <= 2) throw new FarmError("timed out after 30000ms", "timeout");
        return frame("done", [{ name: "login", status: "failed" }]);
      }) as never;
      // A failed flow found after two stalls is still exit 2 - not 0, not 1.
      expect(await runCloud(parseCloud([apk, scenarios]), conn, d)).toBe(EXIT_FLOW_FAILED);
      expect(calls).toBe(3);
    });

    it("gives up non-zero when the farm never answers, naming the job and the uncertainty", async () => {
      const d = deps([]);
      droppedStream(d);
      let calls = 0;
      d.client.getJson = (async () => { calls += 1; throw new FarmError("timed out", "timeout"); }) as never;
      // An undetermined outcome must never read as a pass.
      expect(await runCloud(parseCloud([apk, scenarios]), conn, d)).toBe(EXIT_ERROR);
      const msg = d.err.join("\n");
      expect(msg).toContain("job-1");
      expect(msg).toMatch(/may have (passed|finished)/);
      expect(msg).toContain("deviceyard status");
      expect(calls).toBeLessThanOrEqual(10);
    });

    it("does not retry a failure that retrying cannot fix", async () => {
      const d = deps([]);
      droppedStream(d);
      let calls = 0;
      d.client.getJson = (async () => {
        calls += 1;
        throw new FarmError("the farm rejected the credential (HTTP 401)", "auth", 401);
      }) as never;
      expect(await runCloud(parseCloud([apk, scenarios]), conn, d)).toBe(EXIT_ERROR);
      expect(calls).toBe(1);
    });

    it("counts only CONSECUTIVE failures", async () => {
      const d = deps([]);
      droppedStream(d);
      let calls = 0;
      d.client.getJson = (async () => {
        calls += 1;
        if (calls === 13) return frame("done", [{ name: "login", status: "passed" }]);
        if (calls % 2 === 1) throw new FarmError("timed out", "timeout");
        return { job: { id: "job-1", status: "running", error: null, createdAt: 0 }, steps: [] };
      }) as never;
      expect(await runCloud(parseCloud([apk, scenarios]), conn, d)).toBe(EXIT_OK);
    });
  });

  it("leaves no temp archive behind", async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("deviceyard-")).length;
    const d = deps([frame("done", [{ name: "login", status: "passed" }])]);
    await runCloud(parseCloud([apk, scenarios]), conn, d);
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("deviceyard-")).length;
    expect(after).toBe(before);
  });
});
