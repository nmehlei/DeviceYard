import { execFile } from "child_process";
import path from "path";
import { CliError } from "./exit";

/** Shells out to the system tar rather than bundling a JS tar implementation:
 * src/archive.ts already EXTRACTS with the system tar, docs/guide/running-flows.md
 * already tells people to create the archive with it, and both macOS and every
 * Linux CI image ship one. Keeping both ends on the same tool means a format
 * disagreement between them cannot happen.
 *
 * execFile with an argument array - there is no shell here, so a path
 * containing a space, a quote or a semicolon is not a problem. */
export function buildFlowsArchive(
  e2eRoot: string,
  outPath: string,
  tarBin = "tar",
): Promise<void> {
  const resolved = path.resolve(e2eRoot);
  const parent = path.dirname(resolved);
  const name = path.basename(resolved); // always "e2e"

  return new Promise((resolve, reject) => {
    execFile(tarBin, ["-czf", outPath, "-C", parent, name], (err, _stdout, stderr) => {
      if (!err) return resolve();
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return reject(new CliError(
          `could not run "${tarBin}" to build the flows archive. ` +
          `Install tar, or set DEVICEYARD_TAR to its path.`,
        ));
      }
      reject(new CliError(`failed to build the flows archive: ${stderr.trim() || String(err)}`));
    });
  });
}
