import { execFile } from "node:child_process";

/** Captures one PNG frame from the device. Kept outside CommandRunner
 * deliberately - that abstraction returns stdout/stderr as text, and
 * running raw screen bytes through a string encoding would corrupt them.
 * Shared by the on-demand device screenshot route (api/devices.ts) and the
 * job runner's guaranteed end-of-flow capture (jobRunner.ts). */
export type ScreenshotCapturer = (deviceId: string) => Promise<Buffer>;

// Screenshots need more room than a status-check timeout but must not
// approach runMaestroFlow's 15-minute DEFAULT_TIMEOUT_MS either - a wedged
// device would otherwise park a caller for a quarter hour just to find out
// the screen didn't load.
const SCREENSHOT_TIMEOUT_MS = 15_000;

export const captureDeviceScreenshot: ScreenshotCapturer = (deviceId) =>
  new Promise((resolve, reject) => {
    execFile(
      "adb",
      ["-s", deviceId, "exec-out", "screencap", "-p"],
      { timeout: SCREENSHOT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, encoding: "buffer" },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
