// src/retention.ts
import { log } from "./telemetry/log";
import { recordRetentionEvicted } from "./telemetry/metrics";
import fs from "fs";
import path from "path";
import type { JobRepository } from "./store/jobRepository";
import type { EvictableJobRow, RetentionSettingsRow } from "./store/rows";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure - given the full candidate set (any order in, oldest-first assumed
 * for the size/count thresholds below) and the current settings, returns
 * which job ids should be evicted. Kept separate from any I/O so every
 * threshold combination is testable without a database or filesystem.
 */
export function evaluateRetention(
  jobs: EvictableJobRow[],
  settings: Pick<RetentionSettingsRow, "maxAgeDays" | "maxTotalBytes" | "maxJobs">,
  now: number
): string[] {
  const toEvict = new Set<string>();

  if (settings.maxAgeDays !== null) {
    const cutoff = now - settings.maxAgeDays * DAY_MS;
    for (const job of jobs) {
      if (job.createdAt < cutoff) toEvict.add(job.id);
    }
  }

  if (settings.maxJobs !== null && jobs.length > settings.maxJobs) {
    const excess = jobs.length - settings.maxJobs;
    for (let i = 0; i < excess; i++) toEvict.add(jobs[i].id);
  }

  if (settings.maxTotalBytes !== null) {
    let total = jobs.reduce((sum, job) => sum + job.bytes, 0);
    for (const job of jobs) {
      if (total <= settings.maxTotalBytes) break;
      toEvict.add(job.id);
      total -= job.bytes;
    }
  }

  return [...toEvict];
}

/**
 * One sweep: reads current settings, evaluates eviction, then for each
 * evicted job deletes its artifact files from disk BEFORE deleting its row
 * - files first, so a mid-sweep crash leaves an orphaned file (an
 * inaccurate totalArtifactBytes(), corrected on the next sweep) rather than
 * a database row pointing at nothing. Best-effort per job: a file-delete
 * failure is logged and that job's row is left alone (retried on the next
 * sweep), never aborts the rest of the sweep - matching every other
 * artifact-handling failure in this codebase.
 */
export async function runRetentionSweep(
  repo: JobRepository,
  dataDir: string,
  now: number = Date.now()
): Promise<{ evicted: number }> {
  const settings = repo.getRetentionSettings() ?? { maxAgeDays: null, maxTotalBytes: null, maxJobs: null };
  const jobs = repo.listEvictableJobs();
  const toEvict = evaluateRetention(jobs, settings, now);

  let evicted = 0;
  for (const jobId of toEvict) {
    try {
      await fs.promises.rm(path.join(dataDir, "artifacts", jobId), { recursive: true, force: true });
    } catch (err) {
      log.error("retention: failed to delete artifact files", { jobId, err: String(err) });
      continue;
    }
    try {
      repo.deleteJob(jobId);
      evicted++;
    } catch (err) {
      log.error("retention: failed to delete job row", { jobId, err: String(err) });
    }
  }

  recordRetentionEvicted(evicted);
  return { evicted };
}

/** Fixed, not itself admin-configurable - the settings surface is
 * deliberately limited to the three thresholds that matter operationally
 * (design doc, "Retention sweep"). */
export const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

export interface SweepHandle {
  stop(): void;
}

/** Runs one sweep immediately (so a fresh restart doesn't wait a full
 * interval before its first pass) and then on a fixed timer. `unref()`s the
 * timer so it never keeps the process alive on its own. */
export function startRetentionSweep(
  repo: JobRepository,
  dataDir: string,
  intervalMs: number = SWEEP_INTERVAL_MS
): SweepHandle {
  const tick = (): void => {
    runRetentionSweep(repo, dataDir).catch((err) => {
      log.error("retention sweep failed", { err: String(err) });
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
