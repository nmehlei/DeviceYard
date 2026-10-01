import type { ControlPacket, ControlStream, InputWriter } from "../../src/control/controlStream";

export function fakeStream() {
  const queue: ControlPacket[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let resolveClosed!: () => void;
  const calls: string[] = [];
  const input: InputWriter = {
    injectTouch: async () => { calls.push("touch"); },
    injectKeyCode: async () => { calls.push("key"); },
    injectText: async () => { calls.push("text"); },
    rotateDevice: async () => { calls.push("rotate"); },
  };
  const stream: ControlStream = {
    width: 504,
    height: 1080,
    input,
    // A single consuming generator, woken by push - no timers, so tests never
    // race real time.
    packets: (async function* () {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((r) => { wake = r; });
      }
    })(),
    resetVideo: async () => { calls.push("resetVideo"); },
    closed: new Promise<void>((r) => { resolveClosed = r; }),
    close: async () => { calls.push("close"); ended = true; wake?.(); resolveClosed(); },
  };
  return {
    stream,
    calls,
    push: (p: ControlPacket) => { queue.push(p); wake?.(); },
    /** Simulates the server process exiting on its own. */
    die: () => { ended = true; wake?.(); resolveClosed(); },
  };
}
