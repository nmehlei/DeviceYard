import { ControlHub, type ControlHubDeps, type ControlViewer } from "../../src/control/hub";
import { ControlLeases, type Lease } from "../../src/control/leases";
import type { ControlStream } from "../../src/control/controlStream";
import { log } from "../../src/telemetry/log";
import { fakeStream } from "../helpers/fakeControlStream";

/** Resolves every pending microtask/async step without real time passing. */
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function fakeViewer(userId: number, username: string) {
  const sent: Array<string | Buffer> = [];
  let onClose: (() => void) | undefined;
  let onMessage: ((t: string) => void) | undefined;
  const viewer: ControlViewer = {
    userId, username,
    send: (d) => sent.push(d),
    close: () => onClose?.(),
    on: (_e, cb) => { onClose = cb; },
    onMessage: (cb) => { onMessage = cb; },
  };
  return {
    viewer,
    say: (message: object) => onMessage?.(JSON.stringify(message)),
    disconnect: () => onClose?.(),
    json: () => sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s)),
    binary: () => sent.filter((s): s is Buffer => Buffer.isBuffer(s)),
  };
}

function setup(opts: {
  busy?: boolean;
  waitingJob?: string;
  startFails?: boolean;
  startTimeoutMs?: number;
  startControlStream?: ControlHubDeps["startControlStream"];
  onEvent?: ControlHubDeps["onEvent"];
} = {}) {
  const leases = new ControlLeases({ ttlMs: 30_000, graceMs: 60_000 });
  const sources: Array<{ started: number; stopped: number }> = [];
  const streams: Array<ReturnType<typeof fakeStream>> = [];
  let released = 0;
  let waiting = opts.waitingJob;
  const hub = new ControlHub({
    isDeviceBusy: () => opts.busy ?? false,
    createSource: () => {
      const rec = { started: 0, stopped: 0 };
      sources.push(rec);
      return { start: () => { rec.started++; }, stop: () => { rec.stopped++; } };
    },
    onEvent: opts.onEvent,
    leases,
    startControlStream:
      opts.startControlStream ??
      (async () => {
        if (opts.startFails) throw new Error("device refused scrcpy");
        const s = fakeStream();
        streams.push(s);
        return s.stream;
      }),
    startTimeoutMs: opts.startTimeoutMs,
    hasWaitingJobFor: () => waiting,
    onControlReleased: () => { released++; },
    now: () => 0,
  });
  return { hub, leases, sources, streams, released: () => released, setWaiting: (j?: string) => { waiting = j; } };
}

test("taking control of an idle device starts a stream, stops the screencap loop, and leases it", async () => {
  const t = setup();
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();

  expect(t.streams).toHaveLength(1);
  expect(t.sources[0].stopped).toBeGreaterThanOrEqual(1);
  expect(t.hub.occupiedDeviceIds()).toEqual(["dev-1"]);
  expect(alice.json().at(-1)).toEqual({
    type: "mode", mode: "live-control", label: "Live control", reason: "you are in control", inControl: true,
  });
});

test("another watcher sees who is in control and cannot drive", async () => {
  const t = setup();
  const alice = fakeViewer(1, "alice");
  const bob = fakeViewer(2, "bob");
  t.hub.attach("dev-1", alice.viewer);
  t.hub.attach("dev-1", bob.viewer);
  alice.say({ type: "take-control" });
  await settle();

  expect(bob.json().at(-1)).toMatchObject({ mode: "live-control", reason: "alice is in control", inControl: false });
  bob.say({ type: "key", key: "home" });
  await settle();
  expect(t.streams[0].calls).not.toContain("key");

  bob.say({ type: "take-control" });
  await settle();
  expect(bob.json().at(-1)).toEqual({ type: "control-denied", reason: "alice is in control" });
  expect(t.streams).toHaveLength(1);
});

test("control is refused while a job holds the device, and no stream starts", async () => {
  const t = setup({ busy: true });
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();

  expect(alice.json().at(-1)).toEqual({ type: "control-denied", reason: "a job is running on this device" });
  expect(t.streams).toHaveLength(0);
  expect(t.hub.occupiedDeviceIds()).toEqual([]);
});

test("input from the holder reaches the device", async () => {
  const t = setup();
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();
  alice.say({ type: "touch", action: "down", pointerId: 1, x: 0.5, y: 0.5 });
  alice.say({ type: "text", text: "hallo" });
  await settle();
  expect(t.streams[0].calls).toEqual(expect.arrayContaining(["touch", "text"]));
});

test("malformed input from the holder is dropped, not forwarded", async () => {
  const t = setup();
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();
  // A clean drop never reaches applyInput, so it never logs. Without this,
  // a mutation removing the `if (!input) return` guard would call
  // applyInput(undefined, ...), which throws and is swallowed by the
  // surrounding try/catch - invisible to a bare "calls" assertion, since
  // that throw happens before any InputWriter method runs either way.
  const errorSpy = jest.spyOn(log, "error").mockImplementation(() => {});
  alice.say({ type: "touch", action: "down", pointerId: 1, x: "left", y: 0.5 });
  await settle();
  expect(t.streams[0].calls).not.toContain("touch");
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

test("the holder disconnecting while the stream is still starting installs no session and frees the device", async () => {
  let resolveStart!: (stream: ControlStream) => void;
  const t = setup({
    startControlStream: () => new Promise<ControlStream>((resolve) => { resolveStart = resolve; }),
  });
  const alice = fakeViewer(1, "alice");
  const bob = fakeViewer(2, "bob");
  t.hub.attach("dev-1", alice.viewer);
  t.hub.attach("dev-1", bob.viewer);
  alice.say({ type: "take-control" });
  await settle();

  alice.disconnect();
  await settle();

  const s = fakeStream();
  resolveStart(s.stream);
  await settle();

  // No session was installed for a holder who is already gone: the lease is
  // free, the late-arriving stream was closed rather than left running with
  // nobody driving it, and bob (still watching) is back on snapshots with
  // the screencap loop running again.
  expect(t.hub.occupiedDeviceIds()).toEqual([]);
  expect(s.calls).toContain("close");
  expect(bob.json().at(-1)).toMatchObject({ type: "mode", mode: "snapshot-idle" });
  const last = t.sources.at(-1)!;
  expect(last.started).toBeGreaterThan(last.stopped);
});

test("a start that never settles is released after the start timeout, freeing the device", async () => {
  const t = setup({
    startTimeoutMs: 20,
    startControlStream: () => new Promise<ControlStream>(() => {}), // never resolves
  });
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await new Promise((r) => setTimeout(r, 60));
  await settle();

  expect(t.hub.occupiedDeviceIds()).toEqual([]);
  const error = alice.json().find((m) => m.type === "error");
  expect(error?.message).toContain("did not start");
  expect(alice.json().at(-1)).toMatchObject({ type: "mode", mode: "snapshot-idle" });
});

test("a second take-control while the first is still starting is denied, and starts no second stream", async () => {
  let resolveStart!: (stream: ControlStream) => void;
  let startCalls = 0;
  const t = setup({
    startControlStream: () => {
      startCalls++;
      return new Promise<ControlStream>((resolve) => { resolveStart = resolve; });
    },
  });
  const alice = fakeViewer(1, "alice");
  const bob = fakeViewer(2, "bob");
  t.hub.attach("dev-1", alice.viewer);
  t.hub.attach("dev-1", bob.viewer);
  alice.say({ type: "take-control" });
  await settle();

  bob.say({ type: "take-control" });
  await settle();

  expect(bob.json().at(-1)).toEqual({ type: "control-denied", reason: "control is already being started" });
  expect(startCalls).toBe(1);

  const s = fakeStream();
  resolveStart(s.stream);
  await settle();
  expect(t.hub.occupiedDeviceIds()).toEqual(["dev-1"]);
});

test("the starting guard alone (not the lease) stops a second take-control from starting a second stream", async () => {
  // ControlLeases.acquire already blocks a second concurrent take-control
  // synchronously, which meant the previous test could not tell "the
  // starting guard is doing something" apart from "the lease is doing
  // something". Isolate it: a leases stub that always grants the lease, so
  // only the `starting` guard is left to stop a second startControlStream
  // call.
  const leases = new ControlLeases();
  leases.acquire = (deviceId, holder, now): { ok: true; lease: Lease } => ({
    ok: true,
    lease: { deviceId, holder, acquiredAt: now, lastSeenAt: now },
  });

  let resolveStart!: (stream: ControlStream) => void;
  let startCalls = 0;
  const hub = new ControlHub({
    isDeviceBusy: () => false,
    createSource: () => ({ start: () => {}, stop: () => {} }),
    leases,
    startControlStream: () => {
      startCalls++;
      return new Promise<ControlStream>((resolve) => { resolveStart = resolve; });
    },
    hasWaitingJobFor: () => undefined,
    onControlReleased: () => {},
    now: () => 0,
  });

  const alice = fakeViewer(1, "alice");
  const bob = fakeViewer(2, "bob");
  hub.attach("dev-1", alice.viewer);
  hub.attach("dev-1", bob.viewer);
  alice.say({ type: "take-control" });
  await settle();

  bob.say({ type: "take-control" });
  await settle();

  expect(startCalls).toBe(1);

  const s = fakeStream();
  resolveStart(s.stream);
  await settle();
});

test("a viewer attaching while the stream is still starting does not restart the screencap loop", async () => {
  let resolveStart!: (stream: ControlStream) => void;
  const t = setup({
    startControlStream: () => new Promise<ControlStream>((resolve) => { resolveStart = resolve; }),
  });
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();

  // stopSource already ran as part of taking control; a late-arriving viewer
  // must not undo that while the stream is still starting (Important
  // finding, review round 1) - or the screencap loop would run, invisibly,
  // for the entire live-control session once the stream lands.
  const bob = fakeViewer(2, "bob");
  t.hub.attach("dev-1", bob.viewer);
  await settle();
  const source = t.sources[0];
  expect(source.started).toBe(source.stopped);

  const s = fakeStream();
  resolveStart(s.stream);
  await settle();
  expect(t.hub.occupiedDeviceIds()).toEqual(["dev-1"]);
});

test("video packets fan out tagged by kind", async () => {
  const t = setup();
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();
  t.streams[0].push({ kind: "config", data: Uint8Array.from([7]) });
  t.streams[0].push({ kind: "key", data: Uint8Array.from([8]) });
  t.streams[0].push({ kind: "delta", data: Uint8Array.from([9]) });
  await settle();
  expect(alice.binary().map((b) => [...b])).toEqual([[2, 7], [3, 8], [4, 9]]);
});

test("a viewer joining mid-session gets the cached configuration and forces a keyframe", async () => {
  const t = setup();
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();
  t.streams[0].push({ kind: "config", data: Uint8Array.from([7]) });
  await settle();

  const bob = fakeViewer(2, "bob");
  t.hub.attach("dev-1", bob.viewer);
  await settle();

  // Measured: resetVideo re-sends NO configuration packet, so without the
  // cached one bob could never decode anything.
  expect(bob.binary().map((b) => [...b])).toEqual([[2, 7]]);
  expect(t.streams[0].calls).toContain("resetVideo");
});

test("the holder disconnecting ends control at once and hands the device back", async () => {
  const t = setup();
  const alice = fakeViewer(1, "alice");
  const bob = fakeViewer(2, "bob");
  t.hub.attach("dev-1", alice.viewer);
  t.hub.attach("dev-1", bob.viewer);
  alice.say({ type: "take-control" });
  await settle();

  alice.disconnect();
  await settle();

  expect(t.streams[0].calls).toContain("close");
  expect(t.hub.occupiedDeviceIds()).toEqual([]);
  expect(t.released()).toBe(1);
  expect(bob.json().at(-1)).toMatchObject({ type: "mode", mode: "snapshot-idle" });
  // bob is still watching, so the screencap loop must be running again.
  const last = t.sources.at(-1)!;
  expect(last.started).toBeGreaterThan(last.stopped);
});

test("release-control by the holder ends the session", async () => {
  const t = setup();
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();
  alice.say({ type: "release-control" });
  await settle();
  expect(t.hub.occupiedDeviceIds()).toEqual([]);
  expect(t.released()).toBe(1);
});

test("a stream that fails to start releases the lease and explains itself", async () => {
  const t = setup({ startFails: true });
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();

  expect(t.hub.occupiedDeviceIds()).toEqual([]);
  const error = alice.json().find((m) => m.type === "error");
  expect(error.message).toContain("device refused scrcpy");
  expect(alice.json().at(-1)).toMatchObject({ type: "mode", mode: "snapshot-idle" });
});

test("a stream that dies on its own ends control rather than freezing", async () => {
  const t = setup();
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();
  t.streams[0].die();
  await settle();
  expect(t.hub.occupiedDeviceIds()).toEqual([]);
  expect(alice.json().some((m) => m.type === "error")).toBe(true);
});

test("a waiting job starts a countdown once, and the device is released at the deadline", async () => {
  const t = setup({ waitingJob: "job-a" });
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();

  t.hub.heartbeat("dev-1", 1, 0);
  t.hub.tick(0);
  t.hub.tick(1000);
  const pending = alice.json().filter((m) => m.type === "release-pending");
  expect(pending).toEqual([{ type: "release-pending", releaseAt: 60_000, reason: "a job is waiting for this device" }]);

  t.hub.heartbeat("dev-1", 1, 59_000);
  t.hub.tick(59_999);
  expect(t.hub.occupiedDeviceIds()).toEqual(["dev-1"]);

  t.hub.tick(60_000);
  await settle();
  expect(t.hub.occupiedDeviceIds()).toEqual([]);
  expect(t.released()).toBe(1);
});

test("the countdown is cancelled if the waiting job goes elsewhere", async () => {
  const t = setup({ waitingJob: "job-a" });
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();
  t.hub.tick(0);

  t.setWaiting(undefined);
  t.hub.heartbeat("dev-1", 1, 5000);
  t.hub.tick(5000);
  expect(alice.json().at(-1)).toEqual({ type: "release-cancelled" });

  t.hub.heartbeat("dev-1", 1, 60_000);
  t.hub.tick(60_000);
  expect(t.hub.occupiedDeviceIds()).toEqual(["dev-1"]);
});

test("a silent holder is released after the TTL, and told so rather than silently swapped", async () => {
  const t = setup();
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();
  t.hub.tick(29_999);
  expect(t.hub.occupiedDeviceIds()).toEqual(["dev-1"]);
  t.hub.tick(30_000);
  await settle();
  expect(t.hub.occupiedDeviceIds()).toEqual([]);

  const messages = alice.json();
  const ended = messages.findIndex((m) => m.type === "control-ended");
  const reverted = messages.findIndex((m, i) => i > ended && m.type === "mode" && m.mode === "snapshot-idle");
  expect(messages[ended]).toEqual({ type: "control-ended", reason: "the lease expired" });
  expect(reverted).toBeGreaterThan(ended);
});

test("a throwing onEvent (e.g. the device row was deleted, FK violation) still ends control cleanly and releases the lease on holder disconnect", async () => {
  // Finding 2 (final whole-branch review): onEvent inserts into
  // device_events, whose foreign key can throw. The holder's disconnect
  // handler is unawaited (viewer.on("close", ...) calls void this.endControl
  // - see hub.ts), so an uncaught throw from onEvent inside it becomes an
  // unhandled rejection that could kill the whole process, taking every
  // running CI job with it. onEvent must never be able to do that, and
  // ending control must still complete even when it throws.
  const errorSpy = jest.spyOn(log, "error").mockImplementation(() => {});
  const t = setup({
    onEvent: () => { throw new Error("FK violation: device row is gone"); },
  });
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();
  expect(t.hub.occupiedDeviceIds()).toEqual(["dev-1"]);

  expect(() => alice.disconnect()).not.toThrow();
  await settle();

  expect(t.hub.occupiedDeviceIds()).toEqual([]); // lease released despite onEvent throwing
  expect(t.released()).toBe(1);
  expect(errorSpy).toHaveBeenCalledWith(
    "recording device event failed",
    expect.objectContaining({ deviceId: "dev-1" })
  );
  errorSpy.mockRestore();
});

test("a second tab for the same admin closing does not end control held by the first tab", async () => {
  // Minor finding 4 (final whole-branch review): identity was tracked by
  // userId, not by socket. Two tabs open as the same admin share one
  // userId, so closing the tab that ISN'T driving must not end the other
  // tab's session.
  const t = setup();
  const aliceTab1 = fakeViewer(1, "alice");
  const aliceTab2 = fakeViewer(1, "alice");
  t.hub.attach("dev-1", aliceTab1.viewer);
  t.hub.attach("dev-1", aliceTab2.viewer);
  aliceTab1.say({ type: "take-control" });
  await settle();
  expect(t.hub.occupiedDeviceIds()).toEqual(["dev-1"]);

  aliceTab2.disconnect(); // the non-driving tab
  await settle();

  expect(t.hub.occupiedDeviceIds()).toEqual(["dev-1"]); // control survives
  expect(t.released()).toBe(0);

  aliceTab1.disconnect(); // the driving tab
  await settle();
  expect(t.hub.occupiedDeviceIds()).toEqual([]);
  expect(t.released()).toBe(1);
});

test("only the driving tab's input reaches the device, even from the same admin's other tab", async () => {
  // Minor finding 4 (final whole-branch review): input authorization keyed
  // off userId let a second tab from the same admin drive too.
  const t = setup();
  const aliceTab1 = fakeViewer(1, "alice");
  const aliceTab2 = fakeViewer(1, "alice");
  t.hub.attach("dev-1", aliceTab1.viewer);
  t.hub.attach("dev-1", aliceTab2.viewer);
  aliceTab1.say({ type: "take-control" });
  await settle();

  aliceTab2.say({ type: "touch", action: "down", pointerId: 1, x: 0.5, y: 0.5 });
  await settle();
  expect(t.streams[0].calls).not.toContain("touch");

  aliceTab1.say({ type: "touch", action: "down", pointerId: 1, x: 0.5, y: 0.5 });
  await settle();
  expect(t.streams[0].calls).toContain("touch");
});

test("a viewer joining mid-countdown is told a release is pending", async () => {
  // Minor finding 5 (final whole-branch review): tick() only announces
  // release-pending on the TRANSITION into a countdown - a viewer who
  // attaches after that transition already happened never learns of it.
  const t = setup({ waitingJob: "job-a" });
  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();

  t.hub.heartbeat("dev-1", 1, 0);
  t.hub.tick(0); // starts the countdown; releaseAt = 60_000

  const bob = fakeViewer(2, "bob");
  t.hub.attach("dev-1", bob.viewer);
  await settle();

  expect(bob.json().find((m) => m.type === "release-pending")).toEqual({
    type: "release-pending",
    releaseAt: 60_000,
    reason: "a job is waiting for this device",
  });
});

test("a start that fails after the last viewer has left cleans up the device entry", async () => {
  // Minor finding 6 (final whole-branch review): the `!stillHeld` branch
  // already handles "last viewer left while starting" for a LATE SUCCESS;
  // this is the same situation for a failure, which had no equivalent
  // cleanup - the device stayed in the map forever with its screencap loop
  // never restarted, and no "live view ended" event.
  let rejectStart!: (err: unknown) => void;
  const events: Array<{ deviceId: string; detail: string }> = [];
  const t = setup({
    startControlStream: () => new Promise<ControlStream>((_resolve, reject) => { rejectStart = reject; }),
    onEvent: (deviceId, detail) => events.push({ deviceId, detail }),
  });

  const alice = fakeViewer(1, "alice");
  t.hub.attach("dev-1", alice.viewer);
  alice.say({ type: "take-control" });
  await settle();

  alice.disconnect(); // the only viewer leaves while the start is still in flight
  await settle();

  rejectStart(new Error("device refused scrcpy"));
  await settle();

  expect(t.hub.viewerCount("dev-1")).toBe(0);
  expect(t.hub.occupiedDeviceIds()).toEqual([]);
  expect(events.some((e) => e.detail === "live view ended")).toBe(true);

  // A fresh attach must see a BRAND NEW device entry, not a stale one left
  // behind by the failed start - that only happens if the old entry was
  // actually deleted, so this is what tells the fix apart from a mutant
  // that only sends the events but leaves the map entry in place.
  const carol = fakeViewer(3, "carol");
  t.hub.attach("dev-1", carol.viewer);
  expect(t.sources).toHaveLength(2);
  expect(events.filter((e) => e.detail === "live view started")).toHaveLength(2);
});
