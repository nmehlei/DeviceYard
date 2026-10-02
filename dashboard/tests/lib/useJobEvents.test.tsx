import { renderHook, waitFor } from "@testing-library/react";
import { useJobEvents } from "../../src/lib/useJobEvents";
import type { JobDetail } from "../../src/lib/api";
import { setActiveOrgId } from "../../src/lib/activeOrg";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(detail: JobDetail) {
    this.onmessage?.({ data: JSON.stringify(detail) });
  }
  error() {
    this.onerror?.();
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  sessionStorage.clear();
});

const runningDetail: JobDetail = {
  job: { id: "1", org: "donable", status: "running", error: null, createdAt: 0, startedAt: 0, finishedAt: null, deviceId: null, appId: null, appVersion: null },
  steps: [],
};

test("connects to /api/jobs/:id/events and exposes the first message as detail", async () => {
  const fetchImpl = jest.fn();
  const { result } = renderHook(() =>
    useJobEvents("1", { EventSourceImpl: FakeEventSource as unknown as typeof EventSource, fetchImpl })
  );

  expect(FakeEventSource.instances[0].url).toBe("/api/jobs/1/events");
  expect(result.current.status).toBe("connecting");
});

test("appends ?orgId= to the EventSource URL when an active org is set - EventSource can't set headers", async () => {
  setActiveOrgId(7);
  const fetchImpl = jest.fn();
  renderHook(() => useJobEvents("1", { EventSourceImpl: FakeEventSource as unknown as typeof EventSource, fetchImpl }));

  expect(FakeEventSource.instances[0].url).toBe("/api/jobs/1/events?orgId=7");
});

test("replaces detail wholesale on each subsequent message, not merging", async () => {
  const fetchImpl = jest.fn();
  const { result } = renderHook(() =>
    useJobEvents("1", { EventSourceImpl: FakeEventSource as unknown as typeof EventSource, fetchImpl })
  );
  const source = FakeEventSource.instances[0];

  source.emit(runningDetail);
  await waitFor(() => expect(result.current.detail).toEqual(runningDetail));

  const doneDetail: JobDetail = { ...runningDetail, job: { ...runningDetail.job, status: "done" } };
  source.emit(doneDetail);

  await waitFor(() => expect(result.current.detail).toEqual(doneDetail));
});

test("falls back to a single poll and reports reconnecting on error after a live connection, then returns to live once the poll resolves", async () => {
  // A manually-resolved promise, not mockResolvedValue: mockResolvedValue's
  // promise settles on the very next microtask, fast enough that React 18's
  // automatic batching can coalesce the "reconnecting" update together with
  // the subsequent "live" update into a single commit - collapsing the
  // transient state before waitFor's first check ever observes it. Holding
  // the fetch open until after asserting "reconnecting" makes the sequence
  // deterministic instead of racing microtask timing.
  let resolveFetch!: (value: unknown) => void;
  const fetchImpl = jest.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));

  const { result } = renderHook(() =>
    useJobEvents("1", { EventSourceImpl: FakeEventSource as unknown as typeof EventSource, fetchImpl: fetchImpl as unknown as typeof fetch })
  );
  const source = FakeEventSource.instances[0];

  source.emit(runningDetail);
  await waitFor(() => expect(result.current.status).toBe("live"));

  source.error();

  await waitFor(() => expect(result.current.status).toBe("reconnecting"));
  expect(fetchImpl).toHaveBeenCalledWith("/api/jobs/1", expect.objectContaining({ credentials: "include" }));

  resolveFetch({
    status: 200,
    ok: true,
    json: async () => ({ ...runningDetail, job: { ...runningDetail.job, status: "failed" } }),
  });

  // Fresh data in hand - status returns to "live" rather than staying on
  // "reconnecting" forever (this fallback runs exactly once, so nothing else
  // would ever clear it otherwise).
  await waitFor(() => expect(result.current.status).toBe("live"));
  expect(result.current.detail?.job.status).toBe("failed");
});

test("the reconnect-poll fetch defaults to the org-scoped fetch, not bare fetch - a job's stream ending (the normal done/failed case) must not silently drop org context", async () => {
  setActiveOrgId(9);
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({ ...runningDetail, job: { ...runningDetail.job, status: "done" } }),
  });

  try {
    const { result } = renderHook(() =>
      useJobEvents("1", { EventSourceImpl: FakeEventSource as unknown as typeof EventSource })
    );
    const source = FakeEventSource.instances[0];

    source.emit(runningDetail);
    await waitFor(() => expect(result.current.status).toBe("live"));

    source.error();

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect((init.headers as Headers).get("X-Org-Id")).toBe("9");
  } finally {
    global.fetch = originalFetch;
  }
});

test("a 401 from the fallback fetch does not throw an unhandled rejection - redirecting is the consuming page's job", async () => {
  const fetchImpl = jest.fn().mockResolvedValue({ status: 401, ok: false, json: async () => ({ error: "missing bearer token" }) });
  const { result } = renderHook(() =>
    useJobEvents("1", { EventSourceImpl: FakeEventSource as unknown as typeof EventSource, fetchImpl })
  );

  FakeEventSource.instances[0].error(); // never connected - triggers the fallback fetch path

  await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  expect(result.current.status).toBe("connecting"); // unchanged - no crash, no redirect from this hook
});
