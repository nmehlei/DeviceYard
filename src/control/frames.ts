import type { ScreenshotCapturer } from "../screenshot";

/**
 * A running source of screen frames for one device. The hub starts it when the
 * first viewer attaches and stops it when the last one leaves, so an unwatched
 * device does no capture work at all.
 */
export interface ScreenSource {
  start(): void;
  stop(): void;
}

export interface FrameSourceOptions {
  deviceId: string;
  /** Floor between captures, never a frame rate - see the note below. */
  intervalMs: number;
  capture: ScreenshotCapturer;
  onFrame: (png: Buffer) => void;
  onError: (err: unknown) => void;
  /** Injected so tests drive the loop by hand rather than by sleeping. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

/**
 * One capture loop for one device, over `adb exec-out screencap -p`.
 *
 * Self-scheduling rather than setInterval, and deliberately so: `screencap`
 * was measured at 778-1710ms on an idle device and 1983-2849ms while a job
 * was recording. A fixed interval would queue captures faster than the phone
 * can answer them, piling up adb invocations on a device that is already busy
 * running CI. So `intervalMs` is the gap AFTER a capture completes - a floor
 * between captures, not a frame rate anyone can promise.
 *
 * `screencap` is a SurfaceFlinger read: no encoder, no virtual display. That
 * is what lets this run while a job's `screenrecord` is recording without
 * being able to disturb it.
 */
export function createFrameSource(opts: FrameSourceOptions): ScreenSource {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((timer) => clearTimeout(timer));

  let running = false;
  let timer: NodeJS.Timeout | undefined;

  const cycle = async (): Promise<void> => {
    if (!running) return;
    try {
      const png = await opts.capture(opts.deviceId);
      // stop() may have landed while the capture was outstanding. A frame
      // delivered now would reach a socket the hub has already torn down.
      if (!running) return;
      opts.onFrame(png);
    } catch (err) {
      if (!running) return;
      opts.onError(err);
    }
    if (!running) return;
    timer = setTimer(() => {
      void cycle();
    }, opts.intervalMs);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      void cycle();
    },
    stop(): void {
      running = false;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}
