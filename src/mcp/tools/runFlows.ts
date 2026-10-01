// src/mcp/tools/runFlows.ts
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { FarmClient } from "../client";
import { textResult, errorResult, type ToolResult } from "../result";
import { describeFarmError } from "./reads";

const execFileAsync = promisify(execFile);

export interface RunFlowsArgs {
  apkPath: string;
  flows: string[];
  e2eDir?: string;
  flowsArchive?: string;
}

class ArgError extends Error {}

function requireFile(p: string, label: string): string {
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new ArgError(`${label} is not a file: ${resolved}`);
  }
  return resolved;
}

function requireDir(p: string, label: string): string {
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new ArgError(`${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

export async function runFlows(client: FarmClient, args: RunFlowsArgs): Promise<ToolResult> {
  let tempDir: string | undefined;
  try {
    // Exactly one, never a precedence rule: a caller who passes both has a
    // bug in their reasoning about which one is being run, and silently
    // picking one hides it behind a confusing test result.
    const hasDir = Boolean(args.e2eDir);
    const hasArchive = Boolean(args.flowsArchive);
    if (hasDir === hasArchive) {
      throw new ArgError("pass exactly one of e2eDir or flowsArchive");
    }
    if (!Array.isArray(args.flows) || args.flows.length === 0) {
      throw new ArgError("flows must be a non-empty array of flow identifiers, e.g. [\"map\", \"map/filter\"]");
    }

    const apk = requireFile(args.apkPath, "apkPath");

    // openAsBlob streams from disk rather than reading a ~100MB APK into
    // the heap - the whole reason this client runs locally instead of the
    // bytes travelling through JSON-RPC arguments.
    const form = new FormData();
    form.set("apk", await fs.openAsBlob(apk), path.basename(apk));

    if (hasArchive) {
      const archivePath = requireFile(args.flowsArchive as string, "flowsArchive");
      // A caller-supplied archive is left in place and streamed the same
      // way as the apk - it isn't ours to delete.
      form.set("flowsArchive", await fs.openAsBlob(archivePath), "flows.tar.gz");
    } else {
      const dir = requireDir(args.e2eDir as string, "e2eDir");
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-flows-"));
      const archivePath = path.join(tempDir, "flows.tar.gz");
      // -C the parent and name the directory so the archive contains the
      // same `e2e/`-rooted layout POST /run already expects from CI.
      await execFileAsync("tar", ["-czf", archivePath, "-C", path.dirname(dir), path.basename(dir)]);
      // Same streaming Blob as the apk. postForm awaits fetch, and fetch
      // resolves only once the request body has been sent, so the Blob is
      // fully read well before the `finally` below removes tempDir.
      form.set("flowsArchive", await fs.openAsBlob(archivePath), "flows.tar.gz");
    }
    form.set("flows", JSON.stringify(args.flows));

    const run = await client.postForm("/run", form);
    return textResult(
      `queued job ${run.id} (status ${run.status}) with ${args.flows.length} flow(s).\n` +
      `Each device runs one job at a time, but the farm dispatches across the whole pool. ` +
      `Call wait_for_job with jobId "${run.id}" to follow it, or get_job for a one-shot look.`,
    );
  } catch (err) {
    if (err instanceof ArgError) return errorResult(err.message);
    return errorResult(describeFarmError(err));
  } finally {
    // The archive can be tens of megabytes; a failed upload must not leave
    // one behind in the developer's tmpdir on every retry.
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
