import { getJob, listJobs, getDevice, describeFarmError } from "../../src/mcp/tools/reads";
import { FarmError, type FarmClient } from "../../src/mcp/client";
import type { JobDetail, DeviceResponse } from "../../src/mcp/apiTypes";

function fakeClient(over: Partial<FarmClient> = {}): FarmClient {
  return {
    getJson: async () => ({}) as never,
    getBinary: async () => ({ bytes: Buffer.alloc(0), contentType: "", totalBytes: 0, partial: false }),
    postForm: async () => ({ id: "x", status: "queued" }),
    openEvents: async () => undefined,
    ...over,
  };
}

const detail: JobDetail = {
  job: {
    id: "job-1",
    org: "d",
    status: "done",
    error: null,
    createdAt: Date.parse("2026-09-01T10:00:00.000Z"),
    startedAt: null,
    finishedAt: null,
    appId: null,
    appVersion: null,
  },
  steps: [],
};

describe("describeFarmError", () => {
  it("turns an auth failure into actionable advice", () => {
    expect(describeFarmError(new FarmError("rejected", "auth", 401))).toMatch(/MOBILE_FARM_TOKEN/);
  });

  it("does not pretend to know why a 404 happened", () => {
    const text = describeFarmError(new FarmError("not found: /api/jobs/x", "not_found", 404));
    expect(text).toContain("another org");
  });

  it("passes a non-FarmError through as its message", () => {
    expect(describeFarmError(new Error("weird"))).toContain("weird");
  });

  it("tells the agent a 5xx is the farm's own failure, not the request's", () => {
    const text = describeFarmError(new FarmError("boom", "server", 500));
    expect(text).toContain("boom");
    expect(text).toMatch(/logs/);
    expect(text).toMatch(/retry/);
  });
});

describe("getJob", () => {
  it("requests the right path and returns formatted text", async () => {
    let path = "";
    const result = await getJob(
      fakeClient({
        getJson: async (p: string) => {
          path = p;
          return detail as never;
        },
      }),
      { jobId: "job-1" },
    );
    expect(path).toBe("/api/jobs/job-1");
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("job job-1");
  });

  it("returns an error result, not a throw, when the job is missing", async () => {
    const result = await getJob(
      fakeClient({
        getJson: async () => {
          throw new FarmError("nope", "not_found", 404);
        },
      }),
      { jobId: "ghost" },
    );
    expect(result.isError).toBe(true);
  });
});

describe("listJobs", () => {
  it("clamps the limit into the range the API accepts", async () => {
    const paths: string[] = [];
    const client = fakeClient({
      getJson: async (p: string) => {
        paths.push(p);
        return { jobs: [] } as never;
      },
    });
    await listJobs(client, { limit: 9999 });
    await listJobs(client, { limit: -5 });
    await listJobs(client, {});
    await listJobs(client, { limit: 0 });
    await listJobs(client, { limit: Number.NaN });
    expect(paths).toEqual([
      "/api/jobs?limit=200",
      "/api/jobs?limit=1",
      "/api/jobs?limit=50",
      "/api/jobs?limit=1",
      "/api/jobs?limit=50",
    ]);
  });

  it("floors a fractional limit rather than sending it into a SQL LIMIT", async () => {
    // ?limit=1.5 reaches the server's `LIMIT ?` and errors there; the clamp
    // only guarded the range, never the integrality.
    const paths: string[] = [];
    const client = fakeClient({
      getJson: async (p: string) => {
        paths.push(p);
        return { jobs: [] } as never;
      },
    });
    await listJobs(client, { limit: 1.5 });
    await listJobs(client, { limit: 0.4 });
    await listJobs(client, { limit: 199.99 });
    expect(paths).toEqual([
      "/api/jobs?limit=1",
      "/api/jobs?limit=1",
      "/api/jobs?limit=199",
    ]);
  });
});

describe("getDevice", () => {
  it("calls the plural /api/devices route and returns the payload as pretty JSON", async () => {
    let path = "";
    const payload: DeviceResponse = {
      devices: [{ id: "emulator-5554", label: "phone", model: "Pixel", isActive: true, state: "device" }],
      runnerVersion: "1.2.3",
      artifactBytes: 42,
    };
    const result = await getDevice(
      fakeClient({
        getJson: async (p: string) => {
          path = p;
          return payload as never;
        },
      }),
    );
    expect(path).toBe("/api/devices");
    expect((result.content[0] as { text: string }).text).toContain("emulator-5554");
    expect((result.content[0] as { text: string }).text).toContain("42");
  });

  it("returns an error result when the farm is unreachable", async () => {
    const result = await getDevice(
      fakeClient({
        getJson: async () => {
          throw new FarmError("down", "unreachable");
        },
      }),
    );
    expect(result.isError).toBe(true);
  });
});
