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
export interface BuildInfo {
  version: string;
  edition?: "community" | "pro";
  coreVersion?: string;
  revisions?: { core?: string; pro?: string };
}

export function readBuildInfo(): BuildInfo {
  try {
    const info = fs.readFileSync(path.join(__dirname, "..", "..", "BUILD_INFO"), "utf8");
    const fields = Object.fromEntries(info.split("\n").map(line => line.split("=")));
    const result: BuildInfo = { version: fields.version ?? "unknown" };
    if (fields.edition === "community" || fields.edition === "pro") result.edition = fields.edition;
    if (/^\d+\.\d+\.\d+$/.test(fields.coreVersion ?? "")) result.coreVersion = fields.coreVersion;
    const revisions: NonNullable<BuildInfo["revisions"]> = {};
    for (const key of ["core", "pro"] as const) {
      if (/^[a-f0-9]{40}$/.test(fields[key] ?? "")) revisions[key] = fields[key];
    }
    if (Object.keys(revisions).length) result.revisions = revisions;
    return result;
  } catch {
    return { version: "unknown" };
  }
}

export function readVersion(): string {
  return readBuildInfo().version;
}
