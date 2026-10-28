import fs from "fs";
import path from "path";
import { collectArtifacts } from "./artifacts/collector";
import { extractArchive } from "./archive";
import { prepareDevice } from "./device";
import type { ResetPolicy } from "./store/rows";
import { installApk } from "./install";
import { maskSecrets } from "./env";
import { log } from "./telemetry/log";
import { withSpan } from "./telemetry/tracer";
import { recordJobCompleted, recordFlowRun, type JobOutcome } from "./telemetry/metrics";
import { runMaestroFlow, type CommandRunner } from "./maestro";
import { captureDeviceScreenshot, type ScreenshotCapturer } from "./screenshot";
import { startRecording, type ProcessSpawner } from "./artifacts/recorder";
import type { JobRepository } from "./store/jobRepository";
import type { StepRow } from "./store/rows";
import type { IsolationMode } from "../shared/isolation";
import { IsolationError, type IsolationHooks, type IsolationScope } from "./editions/isolation";

/** Ruling 4: a per-flow job's install step only records where the install went. */
const PER_FLOW_INSTALL_STDOUT = "per-flow isolation: the APK is installed into each flow's work profile";

export interface RunJobOptions {
  jobId: string;
  deviceId: string;
  appId: string;
  dataDir: string;
  apkPath: string;
  flowsArchivePath: string;
  extractDir: string;
  repo: JobRepository;
  runner?: CommandRunner;
  spawner?: ProcessSpawner;
  captureScreenshot?: ScreenshotCapturer;
  /** Called after every persisted state change so SSE clients see progress. */
  onChange?: (jobId: string) => void;
  /** Forwarded to Maestro as `-e KEY=VALUE` for every flow step. Maestro gets
   * the real values; anything this farm persists (artifacts, step previews)
   * gets secret values masked via maskSecrets - see src/env.ts. */
  env?: Record<string, string>;
  /** The device's reset policy, resolved at dispatch. Omitted means the
   * weakest setting - never assume a caller meant to clear a browser. */
  resetPolicy?: ResetPolicy;
  /** Work-profile isolation. Absent or `disabled` runs exactly as before;
   * the other modes need the edition's hooks (Pro). */
  isolation?: { mode: IsolationMode; hooks?: IsolationHooks };
}

/**
 * The whole pipeline for one job: prepare the device, install, extract, then
 * run each flow in turn. Extracted from the route handler in server.ts, where
 * it had grown to about ninety lines inside a queue callback.
 *
 * Every step is persisted twice - once when it starts, once when it lands - so
 * a caller polling mid-run sees 3/10 rather than 0/10 until the very end.
 */
export async function runJob(opts: RunJobOptions): Promise<void> {
  // A thin span wrapper around the unchanged pipeline below. Kept separate so
  // instrumentation cannot alter the ordering guarantees runJobInner
  // documents - cleanup before the terminal finishJob, above all.
  const flowCount = opts.repo.getSteps(opts.jobId).filter((s) => s.kind === "flow").length;
  return withSpan(
    "job",
    {
      "job.id": opts.jobId,
      "device.id": opts.deviceId,
      "app.id": opts.appId,
      "flow.count": flowCount,
    },
    async (span) => {
      // A holder rather than a return value: runJobInner has several terminal
      // paths, and the outcome must still be recorded when one of them throws.
      const outcome: { value: JobOutcome } = { value: "passed" };
      try {
        await runJobInner(opts, outcome);
      } finally {
        span.setAttribute("job.outcome", outcome.value);
        recordJobMetrics(opts, outcome.value);
      }
    }
  );
}

/**
 * Timings come from the job row rather than a stopwatch: createdAt and
 * startedAt are what the queue actually recorded, so queue wait stays honest
 * even when the process restarted between submission and start.
 *
 * Never labelled by job id - see src/telemetry/metrics.ts.
 */
function recordJobMetrics(opts: RunJobOptions, outcome: JobOutcome): void {
  const row = opts.repo.getJob(opts.jobId);
  if (!row) return;

  const finishedAt = row.finishedAt ?? Date.now();
  const startedAt = row.startedAt ?? row.createdAt;

  recordJobCompleted(
    row.org,
    outcome,
    Math.max(0, (finishedAt - startedAt) / 1000),
    Math.max(0, (startedAt - row.createdAt) / 1000)
  );
}

async function runJobInner(
  opts: RunJobOptions,
  outcome: { value: JobOutcome }
): Promise<void> {
  const { repo, jobId } = opts;
  const changed = () => opts.onChange?.(jobId);
  /** Drives job.outcome on the job span. A job whose flows failed still
   * closes as "done" - that is the job's status, not its verdict. */
  let anyFlowFailed = false;
  const captureScreenshot = opts.captureScreenshot ?? captureDeviceScreenshot;

  // Cleanup runs BEFORE the terminal repo.finishJob(...) on every exit path
  // (not after it) so that a GET /run/:id observing status "done"/"failed" is
  // guaranteed to see the temp artifacts already removed - no race between
  // "job looks done" and "cleanup actually finished". This ordering is the
  // fix for intermittent "Cannot log after tests are done" warnings: a test
  // that polled to terminal status used to return while cleanup was still
  // running (and still logging) in the background.
  /**
   * Deliberately NOT wrapped in a span.
   *
   * cleanup() runs twice on the abort path - once in abort(), once again in
   * the outer catch - and the second pass logs ENOENT for files the first one
   * already removed. Wrapping it added enough async machinery for that
   * trailing log to land after a test had finished, failing tests/server.ts
   * with "Cannot log after tests are done" on every run while main was green.
   *
   * Instrumentation that shifts timing enough to change behaviour has failed
   * its own rule, and a span over temp-file deletion was the least valuable
   * one in the tree. The stages that matter - device.prepare, apk.install,
   * archive.extract, flow.run, maestro.exec - are all still traced.
   */
  const cleanup = async (): Promise<void> => {
    for (const target of [opts.apkPath, opts.flowsArchivePath]) {
      try {
        await fs.promises.unlink(target);
      } catch (err) {
        // ENOENT is not a failure: the file being gone is the outcome this
        // loop wants. cleanup() runs twice on the abort path (once in
        // abort(), once in the outer catch), so the second pass ALWAYS hit
        // this branch and logged an error for work that had succeeded -
        // noise in journald, and a log line arriving after the job was
        // already terminal.
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          log.error("failed to delete upload", { path: target, err: String(err) });
        }
      }
    }
    try {
      await fs.promises.rm(opts.extractDir, { recursive: true, force: true });
    } catch (err) {
      log.error("failed to delete extraction dir", { path: opts.extractDir, err: String(err) });
    }
    // Each flow step already removes its own debug/<jobId>/<ordinal>
    // directory once its artifacts are collected, but the debug/<jobId>
    // parent itself is never removed - it accumulates as an empty directory
    // per job forever. Removing it here (once per job, not once per flow)
    // also covers the case where the process died mid-flow before a flow's
    // own cleanup ran: the update timer restarts this service on EVERY
    // merge, which is exactly when jobs can be running, and any debug output
    // left behind holds real screenshots invisible to totalArtifactBytes(),
    // the only early warning that the host is filling up. Best-effort: a
    // failure here is a warning, never an exception - artifact handling
    // stays non-fatal.
    try {
      await fs.promises.rm(path.join(opts.dataDir, "debug", jobId), { recursive: true, force: true });
    } catch (err) {
      log.error("failed to delete job debug dir", { jobId, err: String(err) });
    }
  };

  // --- Work-profile isolation ------------------------------------------------
  // The edition (Pro) owns the profile itself; this module only decides when
  // to create and remove one. A per-job profile is removed by releaseJobScope,
  // which every exit path calls before cleanup() and the terminal finishJob -
  // a finally around everything after creation, spread over the three
  // terminal paths because each of them ends in finishJob. A per-flow profile
  // is removed in the flow loop's own finally.
  const isolationMode: IsolationMode = opts.isolation?.mode ?? "disabled";
  const hooks = opts.isolation?.hooks;
  let jobScope: IsolationScope | undefined;
  /** Where per-job removal warnings go: the last finished flow, else the device step. */
  let removalTargetId: number | undefined;

  /** Pro removes leftover farm profiles here. A failure is a warning, never a failed job. */
  const beforeJob = async (fn: (deviceId: string) => Promise<string[]>): Promise<string[]> => {
    try {
      return await fn(opts.deviceId);
    } catch (err) {
      return [`could not check for leftover work profiles: ${String(err)}`];
    }
  };

  /** An IsolationError is an expected failure carrying the adb output; anything else is a crash. */
  const createScope = async (ordinal?: number): Promise<{ scope: IsolationScope } | { failure: string }> => {
    const input = ordinal === undefined ? { deviceId: opts.deviceId, jobId } : { deviceId: opts.deviceId, jobId, ordinal };
    try {
      const scope = await withSpan("isolation.create", { "device.id": opts.deviceId, "isolation.mode": isolationMode }, () =>
        hooks!.createScope(input)
      );
      return { scope };
    } catch (err) {
      if (!(err instanceof IsolationError)) throw err;
      return { failure: err.output ? `${err.message}\n\n${err.output}` : err.message };
    }
  };

  /** The hook never throws by contract; guarded anyway, since a throw here would skip cleanup. */
  const removeScope = async (scope: IsolationScope): Promise<string[]> => {
    try {
      return await withSpan("isolation.remove", { "device.id": opts.deviceId, "isolation.mode": isolationMode }, () =>
        hooks!.removeScope(opts.deviceId, scope)
      );
    } catch (err) {
      return [`could not remove work profile ${scope.name}: ${String(err)}`];
    }
  };

  const releaseJobScope = async (): Promise<void> => {
    if (!jobScope) return;
    const scope = jobScope;
    jobScope = undefined;
    const warnings = await removeScope(scope);
    if (removalTargetId === undefined) return;
    try {
      repo.appendStepWarnings(removalTargetId, warnings);
    } catch (err) {
      log.error("could not record work profile removal warnings", { jobId, err: String(err) });
    }
  };

  /** A setup or flow step failed. The remaining work cannot succeed, so mark
   * it skipped and close the job as done - matching the long-standing
   * behaviour where a device or install failure is a completed job carrying a
   * failure result, not a crashed one. */
  const abort = async (): Promise<void> => {
    await releaseJobScope();
    repo.skipRemainingSteps(jobId);
    await cleanup();
    repo.finishJob(jobId, "done");
    // The job row closes as "done" (a completed failure, not a crash - see
    // above), but for telemetry a setup that never ran the flows is a failed
    // job. Status and outcome are deliberately different things here.
    outcome.value = "failed";
    changed();
  };

  /**
   * Setup steps (device/install/extract) write no artifacts of their own, so
   * GET /run/:id previously fell back to the stored preview - truncated at
   * PREVIEW_LIMIT (2000 chars) by finishStep. CI used to get the FULL output
   * for these failures; a truncated INSTALL_FAILED_* or tar error loses
   * detail exactly when it's needed. Writing stdout/stderr as artifacts here
   * (no debugDir - there is no Maestro debug output for a setup step) puts
   * the full text on disk so server.ts's readOutput can serve it whole.
   */
  const recordFullOutput = async (step: StepRow, stdout: string, stderr: string): Promise<string[]> => {
    const collected = await collectArtifacts({
      dataDir: opts.dataDir,
      relDir: path.join(jobId, String(step.ordinal)),
      stdout,
      stderr,
    });
    repo.recordArtifacts(step.id, collected.artifacts);
    return collected.warnings;
  };

  /** Runs one flow under Maestro (inside `scope` when isolated) and collects
   * its artifacts. The caller closes the step, so a per-flow profile can be
   * removed first and its warnings land on the same step. */
  const executeFlow = async (
    started: StepRow,
    flowFile: string,
    scope?: IsolationScope
  ): Promise<{ result: { passed: boolean; stdout: string; stderr: string }; warnings: string[] }> => {
    // A dedicated debug directory per flow, keyed by ordinal, so Maestro's
    // screenshots/hierarchy/log for one flow never collide with another's -
    // without this (the brief's original omission), collectArtifacts is
    // never given anywhere to look and Maestro's screenshots - a headline
    // goal of this project - are silently never collected.
    const debugDir = path.join(opts.dataDir, "debug", jobId, String(started.ordinal));
    await fs.promises.mkdir(debugDir, { recursive: true });

    // Records the whole flow, not just its failure moments the way
    // screenshots do - see the design doc's "Video capture" section. The
    // pulled .mp4 lands directly in debugDir, so it needs no changes to
    // collectArtifacts()/classify() below: .mp4 is already classified as
    // "recording" and flows through the same debugDir walk as every other
    // Maestro artifact.
    const recording = startRecording({
      deviceId: opts.deviceId,
      debugDir,
      ordinal: started.ordinal,
      runner: opts.runner,
      spawner: opts.spawner,
    });

    // The exit code only. argv carries -e KEY=VALUE pairs, which is
    // precisely where the secrets are - it must never reach a span.
    const result = await withSpan("maestro.exec", {}, async (execSpan) => {
      const r = await runMaestroFlow(opts.deviceId, flowFile, opts.runner, debugDir, opts.env, scope && hooks?.maestro(scope));
      execSpan.setAttribute("process.exit_code", r.passed ? 0 : 1);
      return r;
    });
    if (!result.passed) anyFlowFailed = true;
    recordFlowRun(result.passed ? "passed" : "failed");
    const { warning: recordingWarning } = await recording.stop();

    const collected = await collectArtifacts({
      dataDir: opts.dataDir,
      relDir: path.join(jobId, String(started.ordinal)),
      debugDir,
      stdout: result.stdout,
      stderr: result.stderr,
      env: opts.env,
    });
    if (recordingWarning) collected.warnings.push(recordingWarning);

    // Whatever screenshots collectArtifacts just found are whatever the
    // flow itself asked for: an explicit takeScreenshot: step (often
    // placed early, e.g. right after login, to confirm landing state) or
    // Maestro's own automatic debug capture (tied to failures, not
    // routine end-of-flow state). Neither guarantees a shot of what the
    // app actually looks like once the flow is DONE, which is what a
    // status/failure review most wants - so capture one explicitly.
    // Recorded after collected.artifacts (below), never before: StepTimeline's
    // findLast(kind === "screenshot") picks the last-inserted match, so this
    // is what always wins as the displayed screenshot, regardless of
    // whatever else the flow captured along the way. Best-effort, like every
    // other artifact here - losing this shot must never fail an otherwise
    // passing flow.
    try {
      const png = await captureScreenshot(opts.deviceId);
      const relPath = path.join(jobId, String(started.ordinal), "final.png");
      await fs.promises.writeFile(path.join(opts.dataDir, "artifacts", relPath), png);
      collected.artifacts.push({ kind: "screenshot", relPath, bytes: png.length });
    } catch (err) {
      collected.warnings.push(`could not capture end-of-flow screenshot: ${String(err)}`);
    }

    repo.recordArtifacts(started.id, collected.artifacts);

    // collectArtifacts COPIES files out of debugDir into dataDir/artifacts -
    // it never moves them, so without this the debug tree lingers forever
    // and every screenshot/recording exists twice on disk. That silently
    // halves the accuracy of totalArtifactBytes(), the only early warning
    // that the farm host is filling up. Best-effort: a failure to remove
    // scratch space must never fail an otherwise-passing flow.
    try {
      await fs.promises.rm(debugDir, { recursive: true, force: true });
    } catch (err) {
      collected.warnings.push(`could not remove debug directory ${debugDir}: ${String(err)}`);
    }

    return { result, warnings: collected.warnings };
  };

  const finishFlow = (
    started: StepRow,
    ran: Awaited<ReturnType<typeof executeFlow>>,
    warnings: string[],
    profileMs?: number
  ): void => {
    repo.finishStep(started.id, {
      status: ran.result.passed ? "passed" : "failed",
      warnings,
      artifactDir: path.join(jobId, String(started.ordinal)),
      stdoutPreview: maskSecrets(ran.result.stdout, opts.env),
      stderrPreview: maskSecrets(ran.result.stderr, opts.env),
      profileMs,
    });
    changed();
  };

  /** A per-flow profile that could not be created or installed into: the flow fails with that output. */
  const failFlow = async (
    started: StepRow,
    output: { stdout: string; stderr: string },
    warnings: string[],
    profileMs?: number
  ): Promise<void> => {
    const outputWarnings = await recordFullOutput(started, output.stdout, output.stderr);
    repo.finishStep(started.id, {
      status: "failed",
      warnings: [...warnings, ...outputWarnings],
      stdoutPreview: output.stdout,
      stderrPreview: output.stderr,
      profileMs,
    });
    changed();
  };

  try {
    repo.markJobRunning(jobId);
    changed();

    const device = repo.startStep(jobId, "device");
    removalTargetId = device.id;
    changed();
    // Undefined while the device step is going well; otherwise its stderr.
    let deviceFailure: string | undefined;
    const deviceWarnings: string[] = [];
    if (isolationMode !== "disabled" && !hooks?.enabled()) {
      deviceFailure = `isolation "${isolationMode}" requires an active DeviceYard Pro license`;
    } else {
      const prep = await withSpan("device.prepare", { "device.id": opts.deviceId }, () =>
        prepareDevice(opts.deviceId, opts.appId, opts.runner, opts.resetPolicy, isolationMode !== "disabled")
      );
      deviceWarnings.push(...prep.warnings);
      if (!prep.ready) {
        deviceFailure = prep.reason ?? "device not ready";
      } else {
        if (hooks?.beforeJob) deviceWarnings.push(...(await beforeJob(hooks.beforeJob)));
        if (isolationMode === "per-job") {
          const created = await createScope();
          if ("failure" in created) {
            deviceFailure = created.failure;
          } else {
            jobScope = created.scope;
            deviceWarnings.push(...created.scope.warnings);
          }
        }
      }
    }
    const deviceOutputWarnings = await recordFullOutput(device, "", deviceFailure ?? "");
    if (deviceFailure !== undefined) {
      repo.finishStep(device.id, {
        status: "failed",
        warnings: [...deviceWarnings, ...deviceOutputWarnings],
        stderrPreview: deviceFailure,
      });
      await abort();
      return;
    }
    repo.finishStep(device.id, {
      status: "passed",
      warnings: [...deviceWarnings, ...deviceOutputWarnings],
      profileMs: jobScope?.durationMs,
    });
    changed();

    const install = repo.startStep(jobId, "install");
    changed();
    // Per-flow jobs install into each flow's own profile (see the flow loop),
    // so this step only says where the install went.
    const installed =
      isolationMode === "per-flow"
        ? { passed: true, stdout: PER_FLOW_INSTALL_STDOUT, stderr: "" }
        : await withSpan("apk.install", { "app.id": opts.appId }, () =>
            installApk(opts.deviceId, opts.apkPath, opts.appId, opts.runner, jobScope?.userId)
          );
    const installOutputWarnings = await recordFullOutput(install, installed.stdout, installed.stderr);
    repo.finishStep(install.id, {
      status: installed.passed ? "passed" : "failed",
      warnings: installOutputWarnings,
      stdoutPreview: installed.stdout,
      stderrPreview: installed.stderr,
    });
    changed();
    if (!installed.passed) {
      await abort();
      return;
    }

    const extract = repo.startStep(jobId, "extract");
    changed();
    const extracted = await withSpan("archive.extract", {}, () =>
      extractArchive(opts.flowsArchivePath, opts.extractDir, opts.runner)
    );
    const extractOutputWarnings = await recordFullOutput(extract, extracted.stdout, extracted.stderr);
    repo.finishStep(extract.id, {
      status: extracted.passed ? "passed" : "failed",
      warnings: extractOutputWarnings,
      stdoutPreview: extracted.stdout,
      stderrPreview: extracted.stderr,
    });
    changed();
    if (!extracted.passed) {
      await abort();
      return;
    }

    for (const [flowIndex, step] of repo
      .getSteps(jobId)
      .filter((s) => s.kind === "flow")
      .entries()) {
      const stop = await withSpan("flow.run", { "flow.name": step.name, "flow.index": flowIndex }, async () => {
      const flowFile = path.join(opts.extractDir, "e2e", "scenarios", `${step.name}.yaml`);
      const started = repo.startStep(jobId, step.name, flowFile);
      changed();

      if (isolationMode !== "per-flow") {
        const ran = await executeFlow(started, flowFile, jobScope);
        finishFlow(started, ran, ran.warnings);
        removalTargetId = started.id;
        return false;
      }

      // Per-flow: a fresh profile with the APK in it, removed before the step
      // closes so its warnings land on this step. A profile that can't be
      // created or installed into fails the flow and the job: the device
      // can't isolate, and there is no fallback to the primary user.
      const created = await createScope(started.ordinal);
      if ("failure" in created) {
        await failFlow(started, { stdout: "", stderr: created.failure }, []);
        return true;
      }
      const scope = created.scope;
      let installed: { passed: boolean; stdout: string; stderr: string } | undefined;
      let ran: Awaited<ReturnType<typeof executeFlow>> | undefined;
      const removal: string[] = [];
      let settled = false;
      try {
        installed = await withSpan("apk.install", { "app.id": opts.appId }, () =>
          installApk(opts.deviceId, opts.apkPath, opts.appId, opts.runner, scope.userId)
        );
        if (installed.passed) ran = await executeFlow(started, flowFile, scope);
        settled = true;
      } finally {
        removal.push(...(await removeScope(scope)));
        // A throw leaves the step running and never closes it; keep the warnings on it anyway.
        if (!settled) repo.appendStepWarnings(started.id, removal);
      }
      if (!ran) {
        await failFlow(started, installed, [...scope.warnings, ...removal], scope.durationMs);
        return true;
      }
      finishFlow(started, ran, [...scope.warnings, ...ran.warnings, ...removal], scope.durationMs);
      return false;
      });
      if (stop) {
        await abort();
        return;
      }
    }

    await releaseJobScope();
    await cleanup();
    repo.finishJob(jobId, "done");
    // The job row is "done" either way; the outcome is about the verdicts.
    outcome.value = anyFlowFailed ? "failed" : "passed";
    changed();
  } catch (err) {
    // Defence in depth: not reachable today (defaultRunner resolves rather
    // than rejects), but this is the composed error path no single task
    // owned, and it sits one runner refactor away from a rejection whose
    // message embeds a raw argv (e.g. "Command failed: maestro ... -e
    // E2E_TEST_PASSWORD=..."). console.error and finishJob's `error` column
    // (returned by GET /run/:id) are both persistence routes, so mask here
    // the same as every other persisted string.
    const message = maskSecrets(err instanceof Error ? err.message : String(err), opts.env);
    log.error("job failed", { jobId, err: message });
    outcome.value = "error";
    await releaseJobScope();
    await cleanup();
    try {
      repo.skipRemainingSteps(jobId);
      repo.finishJob(jobId, "failed", message);
    } catch (storeErr) {
      log.error("could not record job failure", { jobId, err: String(storeErr) });
    }
    changed();
  }
}
