import fs from "fs";
import path from "path";
import type { ArtifactKind } from "../store/rows";
import { isSecretKey, maskSecrets } from "../env";

/** Which artifact kinds are text this farm may rewrite. Decided by kind, never
 * by sniffing content: a file `classify()` does not recognise is dropped
 * entirely rather than copied unclassified (see the `if (!kind) continue`
 * below) - never risking a corrupting rewrite of something we don't
 * understand. `commands-*.json` arrives here as "hierarchy". */
const TEXT_KINDS = new Set<ArtifactKind>(["stdout", "stderr", "log", "hierarchy"]);

export interface CollectedArtifact {
  kind: ArtifactKind;
  /** Path relative to `${dataDir}/artifacts`. Stored in the artifacts table. */
  relPath: string;
  bytes: number;
}

export interface CollectionResult {
  artifacts: CollectedArtifact[];
  warnings: string[];
}

export function classify(fileName: string): ArtifactKind | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "screenshot";
  if (lower.endsWith(".mp4") || lower.endsWith(".webm")) return "recording";
  if (lower.endsWith(".json") || lower.endsWith(".xml")) return "hierarchy";
  // maestro.log is the narrative of what the flow actually did, which is
  // exactly what you reach for once a screenshot alone doesn't explain a
  // failure - so it gets its own kind rather than being dropped on the floor.
  if (lower.endsWith(".log")) return "log";
  return undefined;
}

/**
 * Copies whatever Maestro produced for one flow into DATA_DIR and writes the
 * flow's stdout/stderr alongside it.
 *
 * Everything here is best-effort by design: this mirrors prepareDevice, where
 * readiness is fatal but cleanup is not. Losing a screenshot must never turn a
 * passing flow red - and the artifacts are exactly what you need when the run
 * *did* fail, so failing the run because we could not save them would be
 * perverse.
 */
export async function collectArtifacts(opts: {
  dataDir: string;
  relDir: string;
  debugDir?: string;
  stdout: string;
  stderr: string;
  env?: Record<string, string>;
}): Promise<CollectionResult> {
  const artifacts: CollectedArtifact[] = [];
  const warnings: string[] = [];
  const destDir = path.join(opts.dataDir, "artifacts", opts.relDir);

  try {
    await fs.promises.mkdir(destDir, { recursive: true });
  } catch (err) {
    return { artifacts, warnings: [`could not create artifact directory ${destDir}: ${String(err)}`] };
  }

  const write = async (name: string, kind: ArtifactKind, content: string): Promise<void> => {
    try {
      const dest = path.join(destDir, name);
      const masked = maskSecrets(content, opts.env);
      await fs.promises.writeFile(dest, masked);
      artifacts.push({ kind, relPath: path.join(opts.relDir, name), bytes: Buffer.byteLength(masked) });
    } catch (err) {
      warnings.push(`could not write ${name}: ${String(err)}`);
    }
  };

  // stdout.log/stderr.log are written directly with an explicit kind, never
  // through classify() - so extending classify() to recognise ".log" files
  // in the debug directory (maestro.log) does not change how these two are
  // handled.
  await write("stdout.log", "stdout", opts.stdout);
  await write("stderr.log", "stderr", opts.stderr);

  if (!opts.debugDir) return { artifacts, warnings };

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(opts.debugDir, { withFileTypes: true, recursive: true });
  } catch (err) {
    warnings.push(`could not read maestro debug output at ${opts.debugDir}: ${String(err)}`);
    return { artifacts, warnings };
  }

  // Computed once, not per entry: whether there is anything to mask at all.
  // Gating the read-mask-write path on this (rather than on `opts.env` being
  // merely truthy) keeps a job that supplies only non-secret env - or none -
  // on the byte-exact copyFile path. maestro.log carries device/app output
  // with no UTF-8 guarantee, and hierarchy XML can carry app-supplied text;
  // reading either as "utf8" replaces any invalid byte with U+FFFD, silently
  // reshaping the artifact for reasons unrelated to secrets.
  const hasSecret = !!opts.env && Object.entries(opts.env).some(([key, value]) => isSecretKey(key) && value);

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const kind = classify(entry.name);
    if (!kind) continue;

    // Maestro nests output a directory deep per flow; flatten so one directory
    // per step holds everything, with the parent folded into the name to keep
    // collisions impossible. Node 22.23 populates Dirent.parentPath (the
    // containing directory), not the deprecated-alias-only entry.path, so we
    // read from parentPath and fall back to debugDir only if it is absent.
    const parent = path.relative(opts.debugDir, entry.parentPath ?? opts.debugDir);
    const flatName = parent ? `${parent.split(path.sep).join("-")}-${entry.name}` : entry.name;

    try {
      const source = path.join(entry.parentPath ?? opts.debugDir, entry.name);
      const dest = path.join(destDir, flatName);
      if (hasSecret && TEXT_KINDS.has(kind)) {
        // Read-mask-write rather than copyFile: Maestro writes -e values into
        // its debug output verbatim (mobile-dev-inc/Maestro#2512), so a byte
        // copy would persist the secret we were asked to protect.
        const content = await fs.promises.readFile(source, "utf8");
        await fs.promises.writeFile(dest, maskSecrets(content, opts.env));
      } else {
        await fs.promises.copyFile(source, dest);
      }
      const stat = await fs.promises.stat(dest);
      artifacts.push({ kind, relPath: path.join(opts.relDir, flatName), bytes: stat.size });
    } catch (err) {
      warnings.push(`could not copy artifact ${entry.name}: ${String(err)}`);
    }
  }

  return { artifacts, warnings };
}
