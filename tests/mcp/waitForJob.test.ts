import { waitForJob } from "../../src/mcp/tools/waitForJob";
import { FarmError, type FarmClient } from "../../src/mcp/client";
import type { JobDetail, JobStatus } from "../../src/mcp/apiTypes";

const detail = (status: JobStatus): JobDetail => ({
  job: {
    id: "job-1",
    org: "d",
    status,
    error: null,
    createdAt: 1756718400000,
    startedAt: null,
    finishedAt: null,
    appId: null,
    appVersion: null,
  },
  steps: [],
});

function fakeClient(over: Partial<FarmClient> = {}): FarmClient {
  return {
    getJson: async () => detail("running") as never,
    getBinary: async () => ({ bytes: Buffer.alloc(0), contentType: "", totalBytes: 0, partial: false }),
    postForm: async () => ({ id: "x", status: "queued" }),
    openEvents: async () => undefined,
    ...over,
  };
}

describe("waitForJob", () => {
  it("returns once a frame reports a terminal status", async () => {
    const result = await waitForJob(fakeClient({
      openEvents: async (_p, onFrame) => {
        onFrame(detail("running"));
        onFrame(detail("done"));
      },
    }), { jobId: "job-1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("done");
    expect(result.isError).toBeUndefined();
  });

  it("treats 'failed' as terminal too", async () => {
    const result = await waitForJob(fakeClient({
      openEvents: async (_p, onFrame) => { onFrame(detail("failed")); },
    }), { jobId: "job-1" });
    expect((result.content[0] as { text: string }).text).toContain("failed");
  });

  it("subscribes to the events path for the requested job", async () => {
    let path = "";
    await waitForJob(fakeClient({
      openEvents: async (p, onFrame) => { path = p; onFrame(detail("done")); },
    }), { jobId: "job 1/2" });
    expect(path).toBe("/api/jobs/job%201%2F2/events");
  });

  it("on timeout returns the LAST KNOWN state as a normal result, not an error", async () => {
    const result = await waitForJob(fakeClient({
      openEvents: async (_p, onFrame) => {
        onFrame(detail("running"));
        await new Promise((r) => setTimeout(r, 5000));
      },
    }), { jobId: "job-1", timeoutSeconds: 1 });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("still running");
    expect(text).toContain("running");
  }, 10000);

  it("on timeout with no frames at all, polls once for the state instead of reporting nothing", async () => {
    // The stream can stay open and silent for the whole budget (no
    // heartbeat, no frames). Returning "no state received" after up to 30
    // minutes when one GET answers is the least useful thing this tool
    // could do - the contract is "the last known job state".
    let polled = 0;
    const result = await waitForJob(fakeClient({
      openEvents: async () => { await new Promise((r) => setTimeout(r, 5000)); },
      getJson: async () => { polled += 1; return detail("running") as never; },
    }), { jobId: "job-1", timeoutSeconds: 1 });
    expect(polled).toBe(1);
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("still running");
    expect(text).not.toContain("no state received");
    expect(text).toContain("job-1");
  }, 10000);

  it("reports a terminal job as terminal when the timeout poll finds one, not as 'still running'", async () => {
    const result = await waitForJob(fakeClient({
      openEvents: async () => { await new Promise((r) => setTimeout(r, 5000)); },
      getJson: async () => detail("done") as never,
    }), { jobId: "job-1", timeoutSeconds: 1 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("done");
    expect(text).not.toContain("still running");
  }, 10000);

  it("still says so plainly if the timeout poll also fails", async () => {
    const result = await waitForJob(fakeClient({
      openEvents: async () => { await new Promise((r) => setTimeout(r, 5000)); },
      getJson: async () => { throw new FarmError("down", "unreachable"); },
    }), { jobId: "job-1", timeoutSeconds: 1 });
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("no state received");
  }, 10000);

  it("polls once as a fallback when the stream ends without a terminal frame", async () => {
    let polled = 0;
    const result = await waitForJob(fakeClient({
      openEvents: async () => undefined, // stream dropped immediately
      getJson: async () => { polled += 1; return detail("done") as never; },
    }), { jobId: "job-1" });
    expect(polled).toBe(1);
    expect((result.content[0] as { text: string }).text).toContain("done");
  });

  it("clamps the timeout into 1-1800 seconds", async () => {
    const seen: number[] = [];
    const client = fakeClient({
      openEvents: async (_p, onFrame) => { onFrame(detail("done")); },
    });
    // The clamp is observable through the reported budget on timeout, so
    // assert it directly on the exported helper instead.
    const { clampWaitSeconds } = await import("../../src/mcp/tools/waitForJob");
    seen.push(clampWaitSeconds(99999), clampWaitSeconds(0), clampWaitSeconds(undefined));
    expect(seen).toEqual([1800, 1, 600]);
    await waitForJob(client, { jobId: "job-1" });
  });

  it("polls exactly once when the stream throws and the recovery poll is non-terminal", async () => {
    let getJsonCalls = 0;
    const result = await waitForJob(fakeClient({
      openEvents: async () => { throw new FarmError("dropped", "unreachable"); },
      getJson: async () => { getJsonCalls += 1; return detail("running") as never; },
    }), { jobId: "job-1" });
    expect(getJsonCalls).toBe(1);
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("running");
  });

  it("passes an AbortSignal to openEvents and aborts it once a terminal frame arrives", async () => {
    let captured: AbortSignal | undefined;
    await waitForJob(fakeClient({
      openEvents: async (_p, onFrame, signal) => {
        captured = signal;
        onFrame(detail("done"));
      },
    }), { jobId: "job-1" });
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(true);
  });

  it("passes an AbortSignal to openEvents and aborts it when the wait budget elapses", async () => {
    let captured: AbortSignal | undefined;
    await waitForJob(fakeClient({
      openEvents: async (_p, onFrame, signal) => {
        captured = signal;
        onFrame(detail("running"));
        await new Promise((r) => setTimeout(r, 5000));
      },
    }), { jobId: "job-1", timeoutSeconds: 1 });
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(true);
  }, 10000);

  it("passes an AbortSignal to openEvents and aborts it when the stream throws and the fallback poll settles the job", async () => {
    let captured: AbortSignal | undefined;
    await waitForJob(fakeClient({
      openEvents: async (_p, _onFrame, signal) => {
        captured = signal;
        throw new FarmError("dropped", "unreachable");
      },
      getJson: async () => detail("done") as never,
    }), { jobId: "job-1" });
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(true);
  });

  it("returns an error result when the job does not exist", async () => {
    const result = await waitForJob(fakeClient({
      openEvents: async () => { throw new FarmError("not found: /api/jobs/x", "not_found", 404); },
      getJson: async () => { throw new FarmError("not found: /api/jobs/x", "not_found", 404); },
    }), { jobId: "ghost" });
    expect(result.isError).toBe(true);
  });
});
