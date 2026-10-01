import { ControlHub, type ControlViewer } from "../../src/control/hub";
import { ControlLeases } from "../../src/control/leases";
import { log } from "../../src/telemetry/log";

const controlDeps = {
  leases: new ControlLeases(),
  startControlStream: async () => { throw new Error("not used in Plan A tests"); },
  hasWaitingJobFor: () => undefined,
  onControlReleased: () => {},
};

function fakeViewer() {
  const sent: Array<string | Buffer> = [];
  let onClose: (() => void) | undefined;
  const viewer: ControlViewer = {
    userId: 1,
    username: "watcher",
    send: (d) => sent.push(d),
    close: () => onClose?.(),
    on: (_event, cb) => {
      onClose = cb;
    },
    onMessage: () => {},
  };
  return {
    viewer,
    fireClose: () => onClose?.(),
    json: () => sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s)),
    binary: () => sent.filter((s): s is Buffer => Buffer.isBuffer(s)),
  };
}

function fakeSources() {
  const created: Array<{
    deviceId: string;
    started: boolean;
    stopped: boolean;
    emit: (b: Buffer) => void;
    fail: (e: unknown) => void;
  }> = [];
  const createSource = (
    deviceId: string,
    onFrame: (b: Buffer) => void,
    onError: (e: unknown) => void
  ) => {
    const rec = { deviceId, started: false, stopped: false, emit: onFrame, fail: onError };
    created.push(rec);
    return {
      start: () => {
        rec.started = true;
      },
      stop: () => {
        rec.stopped = true;
      },
    };
  };
  return { created, createSource };
}

const hubWith = (sources: ReturnType<typeof fakeSources>, isDeviceBusy: (d: string) => boolean = () => false) =>
  new ControlHub({ createSource: sources.createSource, isDeviceBusy, ...controlDeps });

test("starts exactly one capture loop for two viewers of the same device", () => {
  const sources = fakeSources();
  const hub = hubWith(sources);
  const a = fakeViewer();
  const b = fakeViewer();

  hub.attach("dev-1", a.viewer);
  hub.attach("dev-1", b.viewer);

  expect(sources.created).toHaveLength(1);
  expect(sources.created[0].started).toBe(true);
  expect(hub.viewerCount("dev-1")).toBe(2);
});

test("fans one frame out to every viewer", () => {
  const sources = fakeSources();
  const hub = hubWith(sources);
  const a = fakeViewer();
  const b = fakeViewer();
  hub.attach("dev-1", a.viewer);
  hub.attach("dev-1", b.viewer);

  sources.created[0].emit(Buffer.from("frame"));

  expect(a.binary()).toHaveLength(1);
  expect(b.binary()).toHaveLength(1);
  expect(a.binary()[0][0]).toBe(1);
  expect(a.binary()[0].subarray(1).toString()).toBe("frame");
});

test("stops the capture loop only when the last viewer leaves", () => {
  const sources = fakeSources();
  const hub = hubWith(sources);
  const a = fakeViewer();
  const b = fakeViewer();
  hub.attach("dev-1", a.viewer);
  hub.attach("dev-1", b.viewer);

  a.fireClose();
  expect(sources.created[0].stopped).toBe(false);

  b.fireClose();
  expect(sources.created[0].stopped).toBe(true);
  expect(hub.viewerCount("dev-1")).toBe(0);
});

test("keeps devices independent", () => {
  const sources = fakeSources();
  const hub = hubWith(sources);
  const a = fakeViewer();
  const b = fakeViewer();
  hub.attach("dev-1", a.viewer);
  hub.attach("dev-2", b.viewer);

  expect(sources.created.map((s) => s.deviceId)).toEqual(["dev-1", "dev-2"]);
  sources.created[0].emit(Buffer.from("only-dev-1"));
  expect(a.binary()).toHaveLength(1);
  expect(b.binary()).toHaveLength(0);
});

test("sends the mode on attach, with a label and a reason", () => {
  const sources = fakeSources();
  const hub = hubWith(sources, (d) => d === "busy-dev");
  const idle = fakeViewer();
  const busy = fakeViewer();

  hub.attach("dev-1", idle.viewer);
  hub.attach("busy-dev", busy.viewer);

  expect(idle.json()[0]).toEqual({
    type: "mode",
    mode: "snapshot-idle",
    label: "Snapshot view",
    reason: "idle",
  });
  expect(busy.json()[0]).toEqual({
    type: "mode",
    mode: "snapshot-job",
    label: "Snapshot view",
    reason: "a job is running",
  });
});

test("a job starting while someone watches changes the label and NOTHING else", () => {
  // Spec D-2: mode follows the lease, not the job. There is no lease yet, so a
  // job starting must not restart the source, swap transport, or drop anyone.
  const sources = fakeSources();
  let busy = false;
  const hub = hubWith(sources, () => busy);
  const v = fakeViewer();
  hub.attach("dev-1", v.viewer);

  busy = true;
  hub.refreshModes();

  expect(sources.created).toHaveLength(1);
  expect(sources.created[0].stopped).toBe(false);
  expect(hub.viewerCount("dev-1")).toBe(1);
  expect(v.json().at(-1)).toEqual({
    type: "mode",
    mode: "snapshot-job",
    label: "Snapshot view",
    reason: "a job is running",
  });
});

test("sends a mode message only when the mode actually changed", () => {
  // refreshModes runs on every job transition. A viewer that receives an
  // identical message each time cannot tell a real change from noise.
  const sources = fakeSources();
  const hub = hubWith(sources);
  const v = fakeViewer();
  hub.attach("dev-1", v.viewer);

  hub.refreshModes();
  hub.refreshModes();

  expect(v.json()).toHaveLength(1);
});

test("forwards a capture failure to viewers without closing the socket", () => {
  const sources = fakeSources();
  const hub = hubWith(sources);
  const v = fakeViewer();
  hub.attach("dev-1", v.viewer);

  sources.created[0].fail(new Error("device offline"));

  const error = v.json().find((m) => m.type === "error");
  expect(error.message).toContain("device offline");
  expect(hub.viewerCount("dev-1")).toBe(1);
});

test("isolates a throwing viewer from the others", () => {
  // Same rule JobEvents.publish follows: one subscriber's bug must never
  // affect the publisher or another subscriber.
  const sources = fakeSources();
  const hub = hubWith(sources);
  const bad: ControlViewer = {
    userId: 99,
    username: "bad",
    send: () => {
      throw new Error("socket gone");
    },
    close: () => {},
    on: () => {},
    onMessage: () => {},
  };
  const good = fakeViewer();
  hub.attach("dev-1", bad);
  hub.attach("dev-1", good.viewer);

  expect(() => sources.created[0].emit(Buffer.from("frame"))).not.toThrow();
  expect(good.binary()).toHaveLength(1);
});

test("records a device event when live view starts and ends", () => {
  const events: Array<{ deviceId: string; detail: string }> = [];
  const sources = fakeSources();
  const hub = new ControlHub({
    createSource: sources.createSource,
    isDeviceBusy: () => false,
    onEvent: (deviceId, detail) => events.push({ deviceId, detail }),
    ...controlDeps,
  });
  const a = fakeViewer();
  const b = fakeViewer();

  hub.attach("dev-1", a.viewer);
  hub.attach("dev-1", b.viewer);
  expect(events).toEqual([{ deviceId: "dev-1", detail: "live view started" }]);

  a.fireClose();
  b.fireClose();
  expect(events).toEqual([
    { deviceId: "dev-1", detail: "live view started" },
    { deviceId: "dev-1", detail: "live view ended" },
  ]);
});

test("a throwing onEvent does not crash the process when a plain watcher disconnects", () => {
  // Finding 2 (final whole-branch review): this path (no control, just
  // viewing) already shipped in an earlier merged PR without a guard - the
  // close handler calls onEvent synchronously inside `ws`'s 'close' emit, so
  // an uncaught throw there kills the process, not just this call. Recording
  // "live view ended" must never be able to do that.
  const errorSpy = jest.spyOn(log, "error").mockImplementation(() => {});
  const sources = fakeSources();
  const hub = new ControlHub({
    createSource: sources.createSource,
    isDeviceBusy: () => false,
    onEvent: () => { throw new Error("FK violation: device row is gone"); },
    ...controlDeps,
  });
  const a = fakeViewer();
  hub.attach("dev-1", a.viewer);

  expect(() => a.fireClose()).not.toThrow();

  expect(hub.viewerCount("dev-1")).toBe(0);
  expect(errorSpy).toHaveBeenCalledWith(
    "recording device event failed",
    expect.objectContaining({ deviceId: "dev-1" })
  );
  errorSpy.mockRestore();
});

test("construction fails fast if startTimeoutMs is not strictly smaller than the lease grace period", () => {
  // Unenforced assumption from the final whole-branch review: the design
  // (D-5) is only safe because a start that HUNG times out at 30s, well
  // before a waiting job's 60s countdown reaches zero. Nothing previously
  // stopped someone from configuring these the wrong way round.
  const sources = fakeSources();
  const tooSlow = () =>
    new ControlHub({
      createSource: sources.createSource,
      isDeviceBusy: () => false,
      leases: new ControlLeases({ graceMs: 60_000 }),
      startControlStream: async () => { throw new Error("not used"); },
      hasWaitingJobFor: () => undefined,
      onControlReleased: () => {},
      startTimeoutMs: 60_000, // equal, not strictly smaller - must also fail
    });
  expect(tooSlow).toThrow(/startTimeoutMs/);

  const evenSlower = () =>
    new ControlHub({
      createSource: sources.createSource,
      isDeviceBusy: () => false,
      leases: new ControlLeases({ graceMs: 60_000 }),
      startControlStream: async () => { throw new Error("not used"); },
      hasWaitingJobFor: () => undefined,
      onControlReleased: () => {},
      startTimeoutMs: 90_000,
    });
  expect(evenSlower).toThrow(/startTimeoutMs/);

  const ok = () =>
    new ControlHub({
      createSource: sources.createSource,
      isDeviceBusy: () => false,
      leases: new ControlLeases({ graceMs: 60_000 }),
      startControlStream: async () => { throw new Error("not used"); },
      hasWaitingJobFor: () => undefined,
      onControlReleased: () => {},
      startTimeoutMs: 30_000,
    });
  expect(ok).not.toThrow();
});

test("close() stops every loop and hangs up on every viewer", () => {
  const sources = fakeSources();
  const hub = hubWith(sources);
  const a = fakeViewer();
  hub.attach("dev-1", a.viewer);
  hub.attach("dev-2", fakeViewer().viewer);

  hub.close();

  expect(sources.created.every((s) => s.stopped)).toBe(true);
  expect(hub.viewerCount("dev-1")).toBe(0);
  expect(hub.viewerCount("dev-2")).toBe(0);
});
