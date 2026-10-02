import fs from "fs";
import path from "path";

/** Reads the version ci/package.sh wrote into BUILD_INFO when it built this
 * bundle (GitVersion mainline semver), so this reports what is actually
 * deployed rather than what this build was compiled from - the two can
 * drift on a rollback or hotfix that doesn't recompile. Resolved from this
 * module's own location (dist/version.js -> bundle root, one level up)
 * rather than process.cwd(): nothing in the systemd unit or the update
 * timer sets a WorkingDirectory. Shared by GET /api/devices' runnerVersion
 * and GET /api/version (the About screen). */
export function readVersion(): string {
  try {
    const info = fs.readFileSync(path.join(__dirname, "..", "..", "BUILD_INFO"), "utf8");
    return info.split("\n").find((l) => l.startsWith("version="))?.slice("version=".length) ?? "unknown";
  } catch {
    return "unknown";
  }
}
