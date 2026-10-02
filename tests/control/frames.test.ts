import { createFrameSource } from "../../src/control/frames";

/**
 * Drives the capture loop by hand. Nothing here sleeps: the suite already
 * flakes under load (docs/open_issues.md, "Test suite (cycle 9)"), and a real
 * timer would make every assertion below a race.
 */
function manualTimer() {
  let pending: (() => void) | undefined;
  return {
    setTimer: (fn: () => void) => {
      pending = fn;
      return 0 as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {
      pending = undefined;
    },
    tick: async () => {
      const fn = pending;
      pending = undefined;
      fn?.();
      await settle();
    },
    get scheduled() {
      return pending !== undefined;
    },
  };
}

/** Lets an already-resolved promise chain run to completion. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

test("emits a frame per cycle", async () => {
  const timer = manualTimer();
  const frames: Buffer[] = [];
  const src = createFrameSource({
    deviceId: "dev-1",
    intervalMs: 1000,
    capture: async () => Buffer.from("png-bytes"),
    onFrame: (f) => frames.push(f),
    onError: () => {},
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  src.start();
  await settle();
  expect(frames).toHaveLength(1);

  await timer.tick();
  expect(frames).toHaveLength(2);
  expect(frames[0].toString()).toBe("png-bytes");
  src.stop();
});

test("never overlaps captures, even when one is slower than the interval", async () => {
  // screencap was measured at up to 2.8s while a job records. A fixed interval
  // would queue captures faster than the phone answers them and pile up adb
  // invocations on a device that is already busy running CI.
  const timer = manualTimer();
  let inFlight = 0;
  let maxInFlight = 0;
  let release: (() => void) | undefined;

  const src = createFrameSource({
    deviceId: "dev-1",
    intervalMs: 1000,
    capture: () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Buffer>((resolve) => {
        release = () => {
          inFlight--;
          resolve(Buffer.from("x"));
        };
      });
    },
    onFrame: () => {},
    onError: () => {},
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  src.start();
  await settle();
  expect(timer.scheduled).toBe(false); // nothing rescheduled while a capture is outstanding

  release!();
  await settle();
  expect(timer.scheduled).toBe(true);
  expect(maxInFlight).toBe(1);
  src.stop();
});

test("reports a capture failure and keeps going", async () => {
  const timer = manualTimer();
  const errors: unknown[] = [];
  let calls = 0;

  const src = createFrameSource({
    deviceId: "dev-1",
    intervalMs: 1000,
    capture: async () => {
      calls++;
      if (calls === 1) throw new Error("device offline");
      return Buffer.from("x");
    },
    onFrame: () => {},
    onError: (e) => errors.push(e),
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  src.start();
  await settle();
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain("device offline");

  await timer.tick();
  expect(calls).toBe(2);
  src.stop();
});

test("emits nothing after stop, including from a capture already in flight", async () => {
  // A late frame would land on a socket the hub has already torn down, or
  // restart a loop nobody is watching.
  const timer = manualTimer();
  const frames: Buffer[] = [];
  let release: ((b: Buffer) => void) | undefined;

  const src = createFrameSource({
    deviceId: "dev-1",
    intervalMs: 1000,
    capture: () => new Promise<Buffer>((resolve) => { release = resolve; }),
    onFrame: (f) => frames.push(f),
    onError: () => {},
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  src.start();
  await settle();
  src.stop();
  release!(Buffer.from("late"));
  await settle();

  expect(frames).toHaveLength(0);
  expect(timer.scheduled).toBe(false);
});

test("reports no error after stop, even if the in-flight capture rejects", async () => {
  const timer = manualTimer();
  const errors: unknown[] = [];
  let fail: ((e: Error) => void) | undefined;

  const src = createFrameSource({
    deviceId: "dev-1",
    intervalMs: 1000,
    capture: () => new Promise<Buffer>((_resolve, reject) => { fail = reject; }),
    onFrame: () => {},
    onError: (e) => errors.push(e),
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  src.start();
  await settle();
  src.stop();
  fail!(new Error("device vanished"));
  await settle();

  expect(errors).toHaveLength(0);
});

test("start is idempotent, so a second start does not create a second loop", async () => {
  const timer = manualTimer();
  let calls = 0;
  const src = createFrameSource({
    deviceId: "dev-1",
    intervalMs: 1000,
    capture: async () => { calls++; return Buffer.from("x"); },
    onFrame: () => {},
    onError: () => {},
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  src.start();
  src.start();
  await settle();
  expect(calls).toBe(1);
  src.stop();
});
