import "@testing-library/jest-dom";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { DeviceScreen, type ScreenState } from "../../src/components/DeviceScreen";

// jsdom (as of 26.x) does not implement PointerEvent at all - `typeof
// PointerEvent` is "undefined" in this environment - so @testing-library/dom
// falls back to the generic `Event` constructor for fireEvent.pointerDown/
// pointerMove/etc, which silently drops clientX/clientY/pointerId from the
// init object. A minimal MouseEvent-based polyfill (MouseEvent does honor
// clientX/clientY in jsdom) restores those fields for the pointer tests below.
if (typeof (globalThis as any).PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
    }
  }
  (globalThis as any).PointerEvent = PointerEventPolyfill;
}

/** Stands in for the browser's WebSocket so a test can deliver frames and
 * closures deterministically, with no server and no timers. */
class FakeSocket {
  static last: FakeSocket | undefined;
  binaryType = "";
  closed = false;
  readonly url: string;
  private listeners = new Map<string, Array<(e: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  addEventListener(type: string, cb: (e: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, event: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
}

const decoded: Array<{ type: string; bytes: number[] }> = [];
const configured: string[] = [];

class FakeDecoder {
  constructor(private readonly init: { output: (f: unknown) => void; error: (e: Error) => void }) {}
  configure(c: { codec: string }) { configured.push(c.codec); }
  decode(chunk: { type: string; data: Uint8Array }) { decoded.push({ type: chunk.type, bytes: [...chunk.data] }); }
  close() {}
}
class FakeChunk {
  type: string; data: Uint8Array;
  constructor(init: { type: string; data: Uint8Array }) { this.type = init.type; this.data = init.data; }
}

beforeEach(() => {
  decoded.length = 0;
  configured.length = 0;
  (globalThis as any).VideoDecoder = FakeDecoder;
  (globalThis as any).EncodedVideoChunk = FakeChunk;
  (globalThis as any).WebSocket = FakeSocket;
  (FakeSocket as any).OPEN = 1;
  URL.createObjectURL = jest.fn(() => "blob:x");
  URL.revokeObjectURL = jest.fn();
});

const SPS = [0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f];
const text = (m: object) => act(() => { FakeSocket.last!.emit("message", { data: JSON.stringify(m) }); });
const binary = (bytes: number[]) => act(() => { FakeSocket.last!.emit("message", { data: Uint8Array.from(bytes).buffer }); });
const goLive = (inControl: boolean) =>
  text({ type: "mode", mode: "live-control", label: "Live control", reason: inControl ? "you are in control" : "alice is in control", inControl });

function mount() {
  const states: ScreenState[] = [];
  render(<DeviceScreen deviceId="dev-1" onState={(s) => states.push(s)} register={() => {}} />);
  (FakeSocket.last as any).readyState = 1;
  return states;
}

test("configures the decoder from the SPS in the configuration packet", () => {
  mount();
  goLive(true);
  binary([2, ...SPS]);
  expect(configured).toEqual(["avc1.42c01f"]);
});

test("drops delta frames until a keyframe has been decoded", () => {
  mount();
  goLive(true);
  binary([2, ...SPS]);
  binary([4, 0xaa]);
  expect(decoded).toEqual([]);
  binary([3, 0xbb]);
  binary([4, 0xcc]);
  expect(decoded.map((d) => d.type)).toEqual(["key", "delta"]);
});

test("prepends the configuration to the keyframe, because scrcpy sends them apart", () => {
  mount();
  goLive(true);
  binary([2, ...SPS]);
  binary([3, 0xbb]);
  expect(decoded[0].bytes).toEqual([...SPS, 0xbb]);
});

test("sends touches while in control", () => {
  mount();
  goLive(true);
  const canvas = screen.getByTestId("device-canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 200, right: 100, bottom: 200, x: 0, y: 0, toJSON() {} });
  canvas.setPointerCapture = () => {};
  const sent: string[] = [];
  (FakeSocket.last as any).send = (m: string) => sent.push(m);
  fireEvent.pointerDown(canvas, { clientX: 50, clientY: 100, pointerId: 7 });
  expect(JSON.parse(sent[0])).toEqual({ type: "touch", action: "down", pointerId: 7, x: 0.5, y: 0.5 });
});

test("sends nothing while someone else is in control", () => {
  mount();
  goLive(false);
  const canvas = screen.getByTestId("device-canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 200, right: 100, bottom: 200, x: 0, y: 0, toJSON() {} });
  canvas.setPointerCapture = () => {};
  const sent: string[] = [];
  (FakeSocket.last as any).send = (m: string) => sent.push(m);
  fireEvent.pointerDown(canvas, { clientX: 50, clientY: 100, pointerId: 7 });
  expect(sent).toEqual([]);
});

test("reports the release countdown", () => {
  const states = mount();
  goLive(true);
  text({ type: "release-pending", releaseAt: 123_000, reason: "a job is waiting for this device" });
  expect(states.at(-1)?.releaseAt).toBe(123_000);
  text({ type: "release-cancelled" });
  expect(states.at(-1)?.releaseAt).toBeUndefined();
});

test("explains why control ended, and the explanation survives the mode reverting", () => {
  // The server sends control-ended and then the snapshot mode. A mode handler
  // that clears notices on every change would erase the reason the instant
  // after it arrived - leaving the admin looking at a picture that silently
  // stopped being live.
  const states = mount();
  goLive(true);
  text({ type: "control-ended", reason: "the lease expired" });
  text({ type: "mode", mode: "snapshot-idle", label: "Snapshot view", reason: "idle" });
  expect(states.at(-1)?.notice).toBe("Control ended: the lease expired");
  expect(states.at(-1)?.mode?.mode).toBe("snapshot-idle");
});

test("a later, unrelated mode change does clear an old notice", () => {
  const states = mount();
  text({ type: "error", message: "screen capture failed: device offline" });
  text({ type: "mode", mode: "snapshot-job", label: "Snapshot view", reason: "a job is running" });
  expect(states.at(-1)?.notice).toBeUndefined();
});

test("a refused upgrade (error then close, no open) reports refused, not closed", () => {
  // Finding 3 (final whole-branch review): browsers fire "error" then
  // "close" for a refused WebSocket upgrade, never "open". The close
  // listener used to unconditionally overwrite the connection state, so
  // "refused" (which carries the admin-only message) was clobbered by
  // "closed" a moment later, and a non-admin saw a generic disconnect
  // message instead of being told why.
  const states = mount();
  act(() => { FakeSocket.last!.emit("error", {}); });
  expect(states.at(-1)?.connection).toBe("refused");
  act(() => { FakeSocket.last!.emit("close", {}); });
  expect(states.at(-1)?.connection).toBe("refused");
});

test("still shows PNG snapshots when not live", () => {
  mount();
  text({ type: "mode", mode: "snapshot-idle", label: "Snapshot view", reason: "idle" });
  binary([1, 0x89, 0x50]);
  expect(screen.getByAltText("Screen of dev-1")).toBeInTheDocument();
});
