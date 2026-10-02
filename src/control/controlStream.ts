/**
 * What the hub needs from a live control session, independent of scrcpy.
 *
 * The shapes of InjectTouch and InjectKeyCode are copied from
 * @yume-chan/scrcpy 2.3.0's own declarations (esm/2_0/impl/inject-touch.d.ts,
 * esm/control/inject-key-code.d.ts) rather than imported: the package is
 * ESM-only and must not be statically reachable from CommonJS source. Keeping
 * them local also documents the exact surface this farm depends on.
 */
export interface ControlPacket {
  kind: "config" | "key" | "delta";
  data: Uint8Array;
}

export interface InjectTouch {
  /** AndroidMotionEventAction: Down 0, Up 1, Move 2, Cancel 3. */
  action: number;
  pointerId: bigint;
  /** In VIDEO pixels; the server rescales to the real display. */
  pointerX: number;
  pointerY: number;
  videoWidth: number;
  videoHeight: number;
  /** 0..1 */
  pressure: number;
  actionButton: number;
  buttons: number;
}

export interface InjectKeyCode {
  /** AndroidKeyEventAction: Down 0, Up 1. */
  action: number;
  keyCode: number;
  repeat: number;
  metaState: number;
}

export interface InputWriter {
  injectTouch(message: InjectTouch): Promise<void>;
  injectKeyCode(message: InjectKeyCode): Promise<void>;
  injectText(text: string): Promise<void>;
  rotateDevice(): Promise<void>;
}

export interface ControlStream {
  readonly width: number;
  readonly height: number;
  readonly packets: AsyncIterable<ControlPacket>;
  readonly input: InputWriter;
  /** Forces a keyframe. Measured at ~242ms; sends NO configuration packet. */
  resetVideo(): Promise<void>;
  /** Resolves when the server process exits for any reason. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export type StartControlStream = (deviceId: string) => Promise<ControlStream>;
