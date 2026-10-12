import { log } from "../telemetry/log";
import type { ScreenSource } from "./frames";
import { FrameTag, tagFrame } from "./frameTags";
import type { ControlLeases } from "./leases";
import type { ControlPacket, ControlStream, StartControlStream } from "./controlStream";
import { applyInput, parseClientInput } from "./input";

export type ControlMode = "snapshot-job" | "snapshot-idle" | "live-control";

export interface ControlViewer {
  readonly userId: number;
  readonly username: string;
  send(data: string | Buffer): void;
  close(): void;
  on(event: "close", cb: () => void): void;
  onMessage(cb: (text: string) => void): void;
}

export interface ControlHubDeps {
  createSource: (deviceId: string, onFrame: (png: Buffer) => void, onError: (err: unknown) => void) => ScreenSource;
  isDeviceBusy: (deviceId: string) => boolean;
  onEvent?: (deviceId: string, detail: string) => void;
  leases: ControlLeases;
  startControlStream: StartControlStream;
  /** The job that would take this device if it were free, or undefined. */
  hasWaitingJobFor: (deviceId: string) => string | undefined;
  /** Called after a lease ends, so a waiting job starts now, not on the next tick. */
  onControlReleased: () => void;
  now?: () => number;
  /** Bounds a `startControlStream` call that never settles: the hub owns the
   * control lifecycle, so the timeout lives here rather than in the scrcpy
   * adapter, which stays a thin wrapper. Defaults to 30s; tests pass a small
   * value to exercise the timeout path without waiting on it. */
  startTimeoutMs?: number;
}

interface LiveControl {
  stream: ControlStream;
  holderId: number;
  holderName: string;
  /** The exact socket driving - not just its userId. The lease (leases.ts)
   * is keyed by userId, which is right for "who may hold this device", but
   * the same admin can have two tabs open. Disconnect and input authorship
   * must key off THIS socket, or closing the tab that isn't driving ends
   * control out from under the other tab, and both tabs can send input. */
  holderViewer: ControlViewer;
  /** Measured: resetVideo re-sends no SPS/PPS, so a late viewer needs this. */
  config?: Uint8Array;
  ending: boolean;
}

interface DeviceState {
  viewers: Set<ControlViewer>;
  source: ScreenSource;
  sourceRunning: boolean;
  mode: ControlMode;
  control?: LiveControl;
  /** A take-control in flight; a second one must not start another stream. */
  starting: boolean;
}

const PACKET_TAG: Record<ControlPacket["kind"], FrameTag> = {
  config: FrameTag.H264Config,
  key: FrameTag.H264Key,
  delta: FrameTag.H264Delta,
};

const DEFAULT_START_TIMEOUT_MS = 30_000;

export class ControlHub {
  private readonly devices = new Map<string, DeviceState>();
  private readonly now: () => number;
  private readonly startTimeoutMs: number;

  constructor(private readonly deps: ControlHubDeps) {
    this.now = deps.now ?? Date.now;
    this.startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    // Unenforced assumption from the final whole-branch review: the design
    // is only safe because startTimeoutMs is strictly smaller than the
    // lease's release grace period (D-5). If it weren't, a start that's
    // merely slow - not hung - could still be running when a waiting job's
    // countdown reaches zero, and the two timers' ordering is exactly what
    // keeps that from happening. Fail construction loudly rather than let
    // that assumption silently rot.
    const graceMs = deps.leases.graceMsValue;
    if (this.startTimeoutMs >= graceMs) {
      throw new Error(
        `ControlHub: startTimeoutMs (${this.startTimeoutMs}ms) must be strictly smaller than the lease grace period (${graceMs}ms)`
      );
    }
  }

  // --- delivery ------------------------------------------------------------

  /** Routes every device-event notification through one place: `onEvent`
   * (server.ts) inserts into `device_events`, whose foreign key can throw
   * (e.g. the device row was deleted concurrently - src/api/devices.ts). That
   * insert happens inside async handlers (`endControl`, the viewer close
   * listener) that nothing awaits and nothing wraps, so an uncaught throw
   * there becomes an unhandled rejection or, from the close listener, a
   * synchronous throw inside `ws`'s 'close' emit - either one kills the whole
   * process, taking every running CI job down with it. Recording a device
   * event must never be able to do that. */
  private emitEvent(deviceId: string, detail: string): void {
    try {
      this.deps.onEvent?.(deviceId, detail);
    } catch (err) {
      log.error("recording device event failed", { deviceId, detail, err: String(err) });
    }
  }

  private deliver(viewer: ControlViewer, data: string | Buffer, deviceId: string): void {
    try {
      viewer.send(data);
    } catch (err) {
      log.error("control viewer send failed", { deviceId, err: String(err) });
    }
  }

  private broadcast(state: DeviceState, deviceId: string, data: string | Buffer): void {
    for (const viewer of state.viewers) this.deliver(viewer, data, deviceId);
  }

  /** Mode copy differs per viewer in live-control: the holder is told they
   * are in control, everyone else who is. */
  private modeMessageFor(state: DeviceState, viewer: ControlViewer): string {
    if (state.mode === "live-control" && state.control) {
      const inControl = viewer.userId === state.control.holderId;
      return JSON.stringify({
        type: "mode",
        mode: "live-control",
        label: "Live control",
        reason: inControl ? "you are in control" : `${state.control.holderName} is in control`,
        inControl,
      });
    }
    const snapshot = state.mode === "snapshot-job"
      ? { label: "Snapshot view", reason: "a job is running" }
      : { label: "Snapshot view", reason: "idle" };
    return JSON.stringify({ type: "mode", mode: state.mode, ...snapshot });
  }

  private sendModeToAll(state: DeviceState, deviceId: string): void {
    for (const viewer of state.viewers) this.deliver(viewer, this.modeMessageFor(state, viewer), deviceId);
  }

  private snapshotMode(deviceId: string): ControlMode {
    return this.deps.isDeviceBusy(deviceId) ? "snapshot-job" : "snapshot-idle";
  }

  // --- screencap loop ------------------------------------------------------

  private startSource(state: DeviceState): void {
    if (state.sourceRunning || state.viewers.size === 0) return;
    state.source.start();
    state.sourceRunning = true;
  }

  private stopSource(state: DeviceState): void {
    if (!state.sourceRunning) return;
    state.source.stop();
    state.sourceRunning = false;
  }

  // --- viewers -------------------------------------------------------------

  attach(deviceId: string, viewer: ControlViewer): void {
    let state = this.devices.get(deviceId);
    if (!state) {
      const created: DeviceState = {
        viewers: new Set(),
        source: this.deps.createSource(
          deviceId,
          (png) => {
            const current = this.devices.get(deviceId);
            if (current && current.mode !== "live-control") {
              this.broadcast(current, deviceId, tagFrame(FrameTag.Png, png));
            }
          },
          (err) => {
            const current = this.devices.get(deviceId);
            if (!current) return;
            this.broadcast(current, deviceId, JSON.stringify({ type: "error", message: `screen capture failed: ${String(err)}` }));
          }
        ),
        sourceRunning: false,
        mode: this.snapshotMode(deviceId),
        starting: false,
      };
      this.devices.set(deviceId, created);
      state = created;
      this.emitEvent(deviceId, "live view started");
    }

    state.viewers.add(viewer);
    // A take-control in flight must not restart the screencap loop - that
    // would run it for the whole live-control session once the stream lands,
    // since frames are only suppressed by mode, not stopped again (Important
    // finding, review round 1).
    if (state.mode !== "live-control" && !state.starting) this.startSource(state);
    this.deliver(viewer, this.modeMessageFor(state, viewer), deviceId);

    if (state.mode === "live-control" && state.control) {
      if (state.control.config) this.deliver(viewer, tagFrame(FrameTag.H264Config, state.control.config), deviceId);
      state.control.stream.resetVideo().catch((err) =>
        log.error("resetVideo failed", { deviceId, err: String(err) })
      );
      // Minor finding: a viewer joining mid-countdown never learned one was
      // running - tick() only announces release-pending on the transition
      // into it, which a late-arriving viewer already missed.
      const lease = this.deps.leases.get(deviceId);
      if (lease?.releaseAt !== undefined) {
        this.deliver(
          viewer,
          JSON.stringify({ type: "release-pending", releaseAt: lease.releaseAt, reason: "a job is waiting for this device" }),
          deviceId
        );
      }
    }

    viewer.onMessage((text) => {
      void this.handleMessage(deviceId, viewer, text);
    });

    viewer.on("close", () => {
      const current = this.devices.get(deviceId);
      if (!current || !current.viewers.delete(viewer)) return;
      // The socket is the heartbeat (D-4): the holder's OWN socket leaving
      // ends control now - a second tab from the same admin closing must not
      // (minor finding: identity is per userId, not per socket).
      if (current.control && current.control.holderViewer === viewer) {
        void this.endControl(deviceId, "the controlling admin disconnected");
      }
      if (current.viewers.size > 0) return;
      this.stopSource(current);
      if (!current.control && !current.starting) {
        this.devices.delete(deviceId);
        this.emitEvent(deviceId, "live view ended");
      }
    });
  }

  private async handleMessage(deviceId: string, viewer: ControlViewer, text: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const type = (raw as { type?: unknown } | null)?.type;

    if (type === "take-control") return this.takeControl(deviceId, viewer);

    const state = this.devices.get(deviceId);
    const control = state?.control;
    if (!state || !control || control.holderViewer !== viewer) return; // only the holder's own socket drives

    this.deps.leases.touch(deviceId, viewer.userId, this.now());
    if (type === "release-control") return this.endControl(deviceId, "released");

    const input = parseClientInput(raw);
    if (!input) return;
    try {
      await applyInput(input, control.stream);
    } catch (err) {
      log.error("control input failed", { deviceId, err: String(err) });
    }
  }

  // --- control lifecycle ---------------------------------------------------

  private async takeControl(deviceId: string, viewer: ControlViewer): Promise<void> {
    const state = this.devices.get(deviceId);
    if (!state) return;
    const deny = (reason: string) => this.deliver(viewer, JSON.stringify({ type: "control-denied", reason }), deviceId);

    if (state.control) {
      if (state.control.holderId !== viewer.userId) deny(`${state.control.holderName} is in control`);
      return;
    }
    if (state.starting) return deny("control is already being started");
    // Checked and acquired in the same synchronous turn: Scheduler.dispatch is
    // synchronous on this event loop, so no job can be claimed in between.
    if (this.deps.isDeviceBusy(deviceId)) return deny("a job is running on this device");

    const acquired = this.deps.leases.acquire(deviceId, { userId: viewer.userId, username: viewer.username }, this.now());
    if (!acquired.ok) return deny(`${acquired.heldBy} is in control`);

    state.starting = true;
    this.stopSource(state); // never screencap and stream at once
    // Not awaited yet: kept so a late resolution after a timeout can still be
    // closed, rather than leaking a scrcpy process onto the phone.
    const startPromise = this.deps.startControlStream(deviceId);
    let stream: ControlStream;
    try {
      stream = await this.withStartTimeout(startPromise);
    } catch (err) {
      state.starting = false;
      this.deps.leases.release(deviceId, viewer.userId);
      this.emitEvent(deviceId, `control failed to start: ${String(err)}`);
      this.broadcast(state, deviceId, JSON.stringify({ type: "error", message: `could not start control: ${String(err)}` }));
      // Minor finding: the last viewer may have left WHILE startControlStream
      // was failing. The `!stillHeld` branch below already handles this for
      // a late-arriving success; a failure needs the identical cleanup, or
      // the device entry is left in the map forever with its screencap loop
      // never restarted, and "live view ended" is never recorded.
      if (this.devices.get(deviceId) === state && state.viewers.size === 0) {
        this.devices.delete(deviceId);
        this.emitEvent(deviceId, "live view ended");
      } else {
        state.mode = this.snapshotMode(deviceId);
        this.startSource(state);
        this.sendModeToAll(state, deviceId);
      }
      this.deps.onControlReleased();
      // The rejection above may be OUR timeout, not the adapter's - the real
      // start can still land later. Close it then so nothing lingers on the
      // phone with no lease and no viewer driving it.
      startPromise
        .then((late) => late.close().catch((closeErr) =>
          log.error("closing late-arriving control stream failed", { deviceId, err: String(closeErr) })
        ))
        .catch(() => {});
      return;
    }

    // The holder may have disconnected (or the whole device entry may have
    // been torn down, e.g. by hub.close()) while startControlStream was in
    // flight. `state.starting` kept the close handler from deleting the
    // device, but a departed holder must never have a session installed for
    // them (Critical finding, review round 1): the socket is the heartbeat,
    // and it already said this viewer is gone.
    const stillHeld = this.devices.get(deviceId) === state && state.viewers.has(viewer);
    if (!stillHeld) {
      state.starting = false;
      this.deps.leases.release(deviceId, viewer.userId);
      this.emitEvent(deviceId, "control abandoned: the holder disconnected before it started");
      await stream.close().catch((err) => log.error("closing abandoned control stream failed", { deviceId, err: String(err) }));
      if (this.devices.get(deviceId) === state) {
        if (state.viewers.size > 0) {
          state.mode = this.snapshotMode(deviceId);
          this.startSource(state);
          this.sendModeToAll(state, deviceId);
        } else {
          this.devices.delete(deviceId);
          this.emitEvent(deviceId, "live view ended");
        }
      }
      this.deps.onControlReleased();
      return;
    }

    state.starting = false;
    state.control = { stream, holderId: viewer.userId, holderName: viewer.username, holderViewer: viewer, ending: false };
    state.mode = "live-control";
    this.emitEvent(deviceId, `control taken by ${viewer.username}`);
    this.sendModeToAll(state, deviceId);

    void this.pump(deviceId, state.control);
    void stream.closed.then(() => {
      if (!state.control || state.control.stream !== stream || state.control.ending) return;
      this.broadcast(state, deviceId, JSON.stringify({ type: "error", message: "the control session ended unexpectedly" }));
      void this.endControl(deviceId, "the stream ended");
    });
  }

  /** Races a `startControlStream` call against `startTimeoutMs` so a hung
   * adapter cannot strand a lease forever - `expired()` only ever REPORTS an
   * occupied device, it never frees one on its own (leases.ts), so without
   * this a `starting` session that never resolves is lost until restart. */
  private withStartTimeout(promise: Promise<ControlStream>): Promise<ControlStream> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`control did not start within ${this.startTimeoutMs}ms`)),
        this.startTimeoutMs
      );
      timer.unref?.();
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }

  private async pump(deviceId: string, control: LiveControl): Promise<void> {
    try {
      for await (const packet of control.stream.packets) {
        const state = this.devices.get(deviceId);
        if (!state || state.control !== control) return;
        if (packet.kind === "config") control.config = packet.data;
        this.broadcast(state, deviceId, tagFrame(PACKET_TAG[packet.kind], packet.data));
      }
    } catch (err) {
      log.error("control stream read failed", { deviceId, err: String(err) });
    }
  }

  private async endControl(deviceId: string, why: string): Promise<void> {
    const state = this.devices.get(deviceId);
    const control = state?.control;
    if (!state || !control || control.ending) return;
    control.ending = true;

    try {
      await control.stream.close();
    } catch (err) {
      log.error("closing control stream failed", { deviceId, err: String(err) });
    }
    this.deps.leases.release(deviceId, control.holderId);
    state.control = undefined;
    state.mode = this.snapshotMode(deviceId);
    this.emitEvent(deviceId, `control ended: ${why}`);
    // Spec: session expiry during active use gets an explicit message, never a
    // silent swap. Sent BEFORE the mode change so the UI can say why the video
    // just turned back into snapshots.
    this.broadcast(state, deviceId, JSON.stringify({ type: "control-ended", reason: why }));

    if (state.viewers.size > 0) {
      this.startSource(state);
      this.sendModeToAll(state, deviceId);
    } else {
      this.devices.delete(deviceId);
      this.emitEvent(deviceId, "live view ended");
    }
    this.deps.onControlReleased();
  }

  // --- time ----------------------------------------------------------------

  heartbeat(deviceId: string, userId: number, now: number): void {
    this.deps.leases.touch(deviceId, userId, now);
  }

  /** Driven by a 1s timer in server.ts; tests call it with explicit times. */
  tick(now: number): void {
    for (const deviceId of this.deps.leases.occupiedDeviceIds()) {
      const state = this.devices.get(deviceId);
      const lease = this.deps.leases.get(deviceId);
      if (!state || !lease) continue;

      const waiting = this.deps.hasWaitingJobFor(deviceId);
      if (waiting && lease.releaseAt === undefined) {
        const releaseAt = this.deps.leases.beginRelease(deviceId, waiting, now);
        this.broadcast(state, deviceId, JSON.stringify({ type: "release-pending", releaseAt, reason: "a job is waiting for this device" }));
      } else if (!waiting && lease.releaseAt !== undefined) {
        this.deps.leases.cancelRelease(deviceId);
        this.broadcast(state, deviceId, JSON.stringify({ type: "release-cancelled" }));
      }
    }
    for (const deviceId of this.deps.leases.expired(now)) {
      void this.endControl(deviceId, "the lease expired");
    }
  }

  refreshModes(): void {
    for (const [deviceId, state] of this.devices) {
      if (state.mode === "live-control") continue; // follows the lease, not the job (D-2)
      const next = this.snapshotMode(deviceId);
      if (next === state.mode) continue;
      state.mode = next;
      this.sendModeToAll(state, deviceId);
    }
  }

  viewerCount(deviceId: string): number {
    return this.devices.get(deviceId)?.viewers.size ?? 0;
  }

  occupiedDeviceIds(): string[] {
    return this.deps.leases.occupiedDeviceIds();
  }

  close(): void {
    for (const [deviceId, state] of this.devices) {
      this.stopSource(state);
      if (state.control) {
        state.control.stream.close().catch(() => {});
        this.deps.leases.release(deviceId, state.control.holderId);
      }
      for (const viewer of state.viewers) {
        try { viewer.close(); } catch { /* already gone */ }
      }
      // Pending starts must not restart capture from this retired state when
      // they fail later, including after a maintenance pause has been resumed.
      state.viewers.clear();
    }
    this.devices.clear();
  }
}
