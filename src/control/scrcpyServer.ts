import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * The scrcpy server binary pushed to a device at the start of a control
 * session. Vendored rather than downloaded at runtime: farm-host installs
 * bundles unattended, and a deploy must not depend on GitHub being reachable
 * from it.
 *
 * Changing the version means changing ALL of: this constant, the checksum, the
 * vendored file, and the AdbScrcpyOptions class in src/control/scrcpy.ts. The
 * server refuses to start on a mismatch, and tests/control/scrcpyServer.test.ts
 * fails first so that the mismatch is a red build rather than a phone that
 * silently will not stream.
 *
 * scrcpy is Apache-2.0, (c) Genymobile; see vendor/scrcpy/LICENSE.
 */
export const SCRCPY_SERVER_VERSION = "3.3.2";
export const SCRCPY_SERVER_SHA256 = "2ee5ca0863ef440f5b7c75856bb475c5283d0a8359cb370b1c161314fd29dfd9";
/** @yume-chan/scrcpy's DefaultServerPath. */
export const SCRCPY_SERVER_DEVICE_PATH = "/data/local/tmp/scrcpy-server.jar";

/**
 * `root` defaults to two levels above this file: the repo root under ts-jest
 * (src/control -> repo), and dist/ in the bundle (dist/src/control -> dist),
 * where ci/package.sh copies vendor/scrcpy.
 */
export function scrcpyServerPath(root: string = path.resolve(__dirname, "..", "..")): string {
  return path.join(root, "vendor", "scrcpy", `scrcpy-server-v${SCRCPY_SERVER_VERSION}`);
}

export async function readVerifiedScrcpyServer(root?: string): Promise<Uint8Array> {
  const file = scrcpyServerPath(root);
  const bytes = await fs.promises.readFile(file);
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== SCRCPY_SERVER_SHA256) {
    throw new Error(
      `scrcpy-server checksum mismatch at ${file}: expected ${SCRCPY_SERVER_SHA256}, got ${actual}`
    );
  }
  return new Uint8Array(bytes);
}
