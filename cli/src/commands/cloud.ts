import fs from "fs";
import os from "os";
import path from "path";
import { FarmError, type FarmClient } from "../../../shared/client";
import type { JobDetail, RunResponse, StepRow } from "../../../shared/apiTypes";
import type { CloudOptions } from "../args";
import type { Resolved } from "../resolve";
import type { Io } from "../main";
import { buildFlowsArchive } from "../archive";
import { parseEnvPairs } from "../envFlags";
import { resolveFlows, filterByTags, readFlowTags } from "../flows";
import { createProgress, type Progress } from "../output";
import { CliError, EXIT_ERROR, EXIT_FLOW_FAILED, EXIT_OK } from "../exit";
import { renderJUnit } from "../report/junit";
import { renderRunJson } from "../report/json";
import { runArtifacts } from "./reads";

export interface CloudDeps {
  client: FarmClient;
  io: Io;
  now(): number;
}

export async function runCloud(
  opts: CloudOptions,
  conn: Resolved,
  deps: CloudDeps,
): Promise<number> {
  const { client, io } = deps;
  const progress = createProgress(io, opts.quiet, deps.now);

  let flows;
  let env;
  let appFile;
  try {
    appFile = path.resolve(opts.appFile ?? opts.appFilePositional!);
    if (!fs.existsSync(appFile)) throw new CliError(`no such app file: ${appFile}`);
    flows = filterByTags(
      resolveFlows(opts.flowsPath, opts.excludeFlows),
      opts.includeTags,
      opts.excludeTags,
    );
    env = parseEnvPairs(opts.envPairs);
  } catch (err) {
    return fail(io, err);
  }

  if (opts.dryRun) {
    io.out(`would upload ${appFile}`);
    io.out(`would archive ${flows.e2eRoot}`);
    io.out(`would run ${flows.flowIds.length} flow(s), in this order:`);
    for (const id of flows.flowIds) {
      const tags = readFlowTags(flows.e2eRoot, id);
      io.out(`  ${id}${tags.length ? `  [${tags.join(", ")}]` : ""}`);
    }
    if (env) io.out(`would pass env: ${Object.keys(env).join(", ")}`);
    return EXIT_OK;
  }

  // A temp directory rather than the cwd: a CI checkout is often read-only,
  // and leaving an e2e.tar.gz behind in someone's repo is its own bug report.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deviceyard-"));
  const archive = path.join(tmp, "e2e.tar.gz");

  let submitted: RunResponse;
  try {
    await buildFlowsArchive(flows.e2eRoot, archive, io.env.DEVICEYARD_TAR);

    const form = new FormData();
    form.set("apk", new Blob([fs.readFileSync(appFile)]), path.basename(appFile));
    form.set("flowsArchive", new Blob([fs.readFileSync(archive)]), "e2e.tar.gz");
    form.set("flows", JSON.stringify(flows.flowIds));
    // Absent is NOT {}: an absent env field must produce a byte-identical
    // argument list to before the feature existed. See src/env.ts.
    if (env) form.set("env", JSON.stringify(env));

    submitted = await client.postForm("/run", form);
  } catch (err) {
    return fail(io, err);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (opts.async) {
    // The id and nothing else on stdout, so a pipeline can capture it with a
    // plain command substitution.
    io.out(submitted.id);
    return EXIT_OK;
  }

  const isTerminal = (d: JobDetail): boolean =>
    d.job.status === "done" || d.job.status === "failed";

  let final: JobDetail | undefined;
  try {
    const controller = new AbortController();
    await client.openEvents(`/api/jobs/${submitted.id}/events`, (data) => {
      const payload = data as JobDetail;
      progress.status(payload.job.status);
      for (const s of payload.steps ?? []) progress.step(s.name, s.status);
      final = payload;
      // The server closes the stream itself once the job reaches done or
      // failed (docs/guide/api-reference.md).
    }, controller.signal);
  } catch (err) {
    // A dropped stream is NOT a failed job. One device means jobs serialize,
    // so a run can sit queued behind someone else's for many minutes, and a
    // long-lived SSE connection through a reverse proxy will not always
    // survive that. Treating the disconnect as a failure abandoned a job that
    // was still running and reported exit 1 - observed against the live farm
    // while queued behind an 11-flow run.
    if (!opts.quiet) {
      io.err(`event stream dropped (${err instanceof Error ? err.message : String(err)}); polling instead`);
    }
  }

  // Poll whenever the stream did not leave us at a terminal state - whether it
  // errored, or closed early without one. The `final &&` is what lets the
  // compiler prove `detail` is defined, rather than an assertion doing it.
  let detail: JobDetail;
  try {
    detail = final && isTerminal(final)
      ? final
      : await pollUntilTerminal(submitted.id, client, progress, io, conn.timeoutMs);
  } catch (err) {
    return fail(io, err);
  }

  const code = summarise(detail, opts, io, submitted.id);

  if (opts.report === "junit") {
    fs.writeFileSync(opts.junitPath ?? "./report.xml", renderJUnit(submitted.id, detail.steps ?? []));
  }

  const json = renderRunJson(submitted.id, conn.farmUrl, detail);
  if (opts.jsonFile) fs.writeFileSync(opts.jsonFileName ?? `${submitted.id}_deviceyard.json`, json);
  if (opts.json) io.out(json);

  if (opts.downloadArtifacts) {
    // Best-effort, and deliberately after the code is decided: a download
    // problem must not overwrite the verdict the flows earned.
    try {
      await runArtifacts(submitted.id, opts.downloadArtifacts, opts.artifactsPath, client, io);
    } catch (err) {
      io.err(`artifact download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return code;
}

/** How long to keep waiting for a job after the event stream is gone. A run
 * queued behind a long one can legitimately take a while, so this is generous
 * - but it is bounded, because an unattended CI job that waits forever is its
 * own kind of failure. */
const DEFAULT_WAIT_MS = 3_600_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Ceiling for ONE poll request. Not the client's default timeout, which is
 * sized for uploads and downloads (15 minutes): a poll is a tiny read that
 * can simply be asked again, so a stalled one should fail fast. Build 2373
 * showed why - the job had finished, the first poll after the stream dropped
 * stalled, and the 15-minute default outlived the pipeline's own 15-minute
 * job limit, so the CLI's timeout could never fire first and the agent was
 * killed from outside. */
const POLL_REQUEST_TIMEOUT_MS = 30_000;

/** How many polls in a row may fail in a transient way before giving up. The
 * job already exists on the farm, so asking again is a read, never a second
 * job. Consecutive, because a farm that answers now and then is still
 * reachable; one that never answers is not. Worst case this is about
 * MAX x (POLL_REQUEST_TIMEOUT_MS + interval), i.e. under three minutes. */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/** A different failure on the next attempt is plausible for these; for auth
 * or not-found it is not, and looping would only delay the real message. */
const isTransient = (err: unknown): err is FarmError =>
  err instanceof FarmError && (err.kind === "timeout" || err.kind === "unreachable" || err.kind === "server");

const envMs = (raw: string | undefined, fallback: number): number =>
  raw && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : fallback;

async function pollUntilTerminal(
  jobId: string,
  client: FarmClient,
  progress: Progress,
  io: Io,
  clientTimeoutMs: number,
): Promise<JobDetail> {
  const budget = envMs(io.env.DEVICEYARD_WAIT_MS, DEFAULT_WAIT_MS);
  const interval = envMs(io.env.DEVICEYARD_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS);
  // Never longer than what the user asked for with their own timeout.
  const requestTimeout = Math.min(POLL_REQUEST_TIMEOUT_MS, clientTimeoutMs);
  const deadline = Date.now() + budget;
  let failures = 0;

  for (;;) {
    let detail: JobDetail | undefined;
    try {
      detail = await client.getJson<JobDetail>(`/api/jobs/${jobId}`, { timeoutMs: requestTimeout });
      failures = 0;
    } catch (err) {
      if (!isTransient(err)) throw err;
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        // Deliberately an error and not a guess: the run may well have passed
        // on the device, but a pipeline must not be told so on no evidence.
        throw new CliError(
          `lost contact with the farm while waiting for job ${jobId}: ${failures} polls in a row failed ` +
          `(last: ${err.message}). The run may have passed or failed on the device - its outcome is ` +
          `unknown from here. Check it with: deviceyard status ${jobId}`,
        );
      }
      io.err(`poll failed (${err.message}); asking again`);
    }

    if (detail) {
      progress.status(detail.job.status);
      for (const s of detail.steps ?? []) progress.step(s.name, s.status);
      if (detail.job.status === "done" || detail.job.status === "failed") return detail;
    }

    if (Date.now() > deadline) {
      throw new CliError(
        `gave up waiting for job ${jobId} after ${Math.round(budget / 1000)}s; it is still ` +
        `${detail?.job.status ?? "of unknown status"}. Check it with: deviceyard status ${jobId}` +
        `${io.env.DEVICEYARD_WAIT_MS ? "" : " (raise DEVICEYARD_WAIT_MS to wait longer)"}`,
      );
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

function fail(io: Io, err: unknown): number {
  // FarmError already carries the farm's own reason, already redacted.
  io.err(err instanceof FarmError || err instanceof CliError ? err.message : String(err));
  return EXIT_ERROR;
}

export function summarise(
  detail: JobDetail,
  opts: CloudOptions,
  io: Io,
  jobId: string,
): number {
  const steps: StepRow[] = detail.steps ?? [];
  const flowSteps = steps.filter((s) => s.kind === "flow");
  const failed = flowSteps.filter((s) => s.status === "failed");

  io.out("");
  io.out(`job ${jobId}: ${flowSteps.length - failed.length}/${flowSteps.length} passed`);
  for (const s of failed) io.out(`  FAIL  ${s.name}`);

  // A job failure with NO flow verdicts is a setup failure - no active device,
  // the install failed, the archive would not extract. That is infrastructure,
  // and returning 2 would tell a pipeline to retry it as a flaky test.
  if (detail.job.status === "failed" && flowSteps.length === 0) {
    io.err(detail.job.error ?? "the job failed before any flow ran");
    return EXIT_ERROR;
  }

  if (failed.length === 0) return EXIT_OK;
  // --json-file means "I will read the file myself" - do not also fail the build.
  return opts.jsonFile ? EXIT_OK : EXIT_FLOW_FAILED;
}
