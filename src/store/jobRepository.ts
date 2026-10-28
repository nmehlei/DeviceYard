import type { Db } from "../db/driver";
import { maskEnvForStorage } from "../env";
import { log } from "../telemetry/log";
import { parseDeviceTags } from '../../shared/deviceTags';
import { parseIsolation, type IsolationMode } from '../../shared/isolation';
import type {
  ArtifactKind,
  ArtifactRow,
  EvictableJobRow,
  JobRow,
  JobStatus,
  RetentionSettingsRow,
  SchedulerSettingsRow,
  UploadSettingsRow,
  StepKind,
  StepRow,
  StepStatus,
} from "./rows";

/** Fixed preamble every job runs before its flows, in this order. Laid down
 * at creation so the dashboard can render the whole timeline immediately
 * rather than growing it a row at a time. */
export const SETUP_STEPS = ["device", "install", "extract"] as const;

/** Inline output is capped so list views stay cheap; the full text is written
 * to disk as an artifact and served separately. */
export const PREVIEW_LIMIT = 2000;

function preview(text: string | undefined): string | null {
  if (text === undefined) return null;
  if (text.length <= PREVIEW_LIMIT) return text;
  return `${text.slice(0, PREVIEW_LIMIT)}\n… truncated, ${text.length - PREVIEW_LIMIT} more characters — see the full log`;
}

interface JobRecord {
  isolation: string;
  required_device_tags_json: string;
  id: string;
  org: string;
  status: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  env_json: string | null;
  device_id: string | null;
  app_id: string | null;
  app_version: string | null;
}

interface StepRecord {
  id: number;
  job_id: string;
  ordinal: number;
  kind: string;
  name: string;
  status: string;
  exit_code: number | null;
  started_at: number | null;
  finished_at: number | null;
  resolved_path: string | null;
  artifact_dir: string | null;
  warnings: string | null;
  stdout_preview: string | null;
  stderr_preview: string | null;
  profile_ms: number | null;
}

function toJob(record: JobRecord): JobRow {
  return {
    isolation: parseIsolation(record.isolation),
    requiredDeviceTags: parseDeviceTags(JSON.parse(record.required_device_tags_json)),
    id: record.id,
    org: record.org,
    status: record.status as JobStatus,
    error: record.error,
    createdAt: record.created_at,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    envJson: record.env_json,
    deviceId: record.device_id,
    appId: record.app_id,
    appVersion: record.app_version,
  };
}

// Parses the warnings column defensively: a later task starts writing real
// data here, and a crash on read would take down every job listing that
// touches the affected row rather than just degrading that one field.
function parseWarnings(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

interface ArtifactRecord {
  id: number;
  flow_run_id: number;
  kind: string;
  rel_path: string;
  bytes: number;
  created_at: number;
}

function toArtifact(record: ArtifactRecord): ArtifactRow {
  return {
    id: record.id,
    flowRunId: record.flow_run_id,
    kind: record.kind as ArtifactKind,
    relPath: record.rel_path,
    bytes: record.bytes,
    createdAt: record.created_at,
  };
}

/** 512 MB. Comfortably above a fat multi-architecture debug testing APK
 * (150-300 MB is typical), so enabling this by default cannot break the live
 * pipeline, while still bounding an agent looping run_flows against a host
 * whose job is to keep a phone on USB. */
export const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

interface UploadSettingsRecord {
  id: number;
  max_upload_bytes: number | null;
  updated_at: number;
}

interface SchedulerSettingsRecord {
  id: number;
  max_concurrent_jobs: number | null;
  updated_at: number;
}

interface RetentionSettingsRecord {
  max_age_days: number | null;
  max_total_bytes: number | null;
  max_jobs: number | null;
  updated_at: number;
}

function toRetentionSettings(record: RetentionSettingsRecord): RetentionSettingsRow {
  return {
    maxAgeDays: record.max_age_days,
    maxTotalBytes: record.max_total_bytes,
    maxJobs: record.max_jobs,
    updatedAt: record.updated_at,
  };
}

function toStep(record: StepRecord): StepRow {
  return {
    id: record.id,
    jobId: record.job_id,
    ordinal: record.ordinal,
    kind: record.kind as StepKind,
    name: record.name,
    status: record.status as StepStatus,
    exitCode: record.exit_code,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    resolvedPath: record.resolved_path,
    artifactDir: record.artifact_dir,
    warnings: parseWarnings(record.warnings),
    stdoutPreview: record.stdout_preview,
    stderrPreview: record.stderr_preview,
    profileMs: record.profile_ms,
  };
}

export class JobRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Date.now()
  ) {}

  createJob(
    org: string,
    flows: string[],
    env?: Record<string, string>,
    appId?: string | null,
    appVersion?: string | null,
    preparedId?: string,
    requiredDeviceTags: string[] = [],
    isolation: IsolationMode = 'disabled'
  ): JobRow {
    const createdAt = this.now();
    const id = preparedId ?? `${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
    const envJson = env === undefined ? null : JSON.stringify(maskEnvForStorage(env));
    const tagsJson = JSON.stringify(parseDeviceTags(requiredDeviceTags));
    const isolationMode = parseIsolation(isolation);

    this.db.exec("BEGIN");
    try {
      this.db.run(
        "INSERT INTO jobs (id, org, status, created_at, env_json, app_id, app_version, required_device_tags_json, isolation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        org,
        "queued",
        createdAt,
        envJson,
        appId ?? null,
        appVersion ?? null,
        tagsJson,
        isolationMode
      );

      const names = [...SETUP_STEPS.map((name) => ({ kind: "setup", name })), ...flows.map((name) => ({ kind: "flow", name }))];
      names.forEach((step, ordinal) => {
        this.db.run(
          "INSERT INTO flow_runs (job_id, ordinal, kind, name, status) VALUES (?, ?, ?, ?, ?)",
          id,
          ordinal,
          step.kind,
          step.name,
          "queued"
        );
      });

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    const job = this.getJob(id);
    if (!job) throw new Error(`job ${id} vanished immediately after insert`);
    return job;
  }

  getJob(id: string): JobRow | undefined {
    const record = this.db.get<JobRecord>("SELECT * FROM jobs WHERE id = ?", id);
    return record ? toJob(record) : undefined;
  }

  getSteps(jobId: string): StepRow[] {
    return this.db
      .all<StepRecord>("SELECT * FROM flow_runs WHERE job_id = ? ORDER BY ordinal ASC", jobId)
      .map(toStep);
  }

  /**
   * Look up a single step by id, independent of its job. Callers that need
   * to check ownership (does this step belong to this org?) join through
   * `jobId` to `getJob` themselves - deriving that from a stored artifact
   * path instead would be one string-format assumption away from silently
   * mis-attributing ownership.
   */
  getStep(id: number): StepRow | undefined {
    const record = this.db.get<StepRecord>("SELECT * FROM flow_runs WHERE id = ?", id);
    return record ? toStep(record) : undefined;
  }

  markJobRunning(id: string): void {
    this.db.run(
      "UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?",
      this.now(),
      id
    );
  }

  startStep(jobId: string, name: string, resolvedPath?: string): StepRow {
    // A job can contain two rows with the same name: SETUP_STEPS reuses
    // "device"/"install"/"extract", and a flow list can itself repeat a name.
    // Targeting by name+status alone would flip every matching row at once,
    // stranding the others as permanently 'running'. Ordinal ASC picks the
    // earliest queued occurrence, which is always correct: setup rows sit at
    // ordinals 0-2 and are consumed before any same-named flow row that
    // appears later, so each call takes the next row in sequence.
    const target = this.db.get<{ id: number }>(
      "SELECT id FROM flow_runs WHERE job_id = ? AND name = ? AND status = 'queued' ORDER BY ordinal ASC LIMIT 1",
      jobId,
      name
    );
    if (!target) throw new Error(`no queued step "${name}" on job ${jobId}`);

    this.db.run(
      `UPDATE flow_runs SET status = 'running', started_at = ?, resolved_path = COALESCE(?, resolved_path)
       WHERE id = ?`,
      this.now(),
      resolvedPath ?? null,
      target.id
    );

    const record = this.db.get<StepRecord>("SELECT * FROM flow_runs WHERE id = ?", target.id);
    if (!record) throw new Error(`step ${target.id} not found`);
    return toStep(record);
  }

  finishStep(
    stepId: number,
    result: {
      status: StepStatus;
      exitCode?: number;
      warnings?: string[];
      resolvedPath?: string;
      artifactDir?: string;
      stdoutPreview?: string;
      stderrPreview?: string;
      profileMs?: number;
    }
  ): StepRow {
    this.db.run(
      `UPDATE flow_runs
         SET status = ?, exit_code = ?, finished_at = ?,
             warnings = ?, artifact_dir = COALESCE(?, artifact_dir),
             resolved_path = COALESCE(?, resolved_path),
             stdout_preview = ?, stderr_preview = ?, profile_ms = ?
       WHERE id = ?`,
      result.status,
      result.exitCode ?? null,
      this.now(),
      result.warnings && result.warnings.length > 0 ? JSON.stringify(result.warnings) : null,
      result.artifactDir ?? null,
      result.resolvedPath ?? null,
      preview(result.stdoutPreview),
      preview(result.stderrPreview),
      result.profileMs ?? null,
      stepId
    );

    const record = this.db.get<StepRecord>("SELECT * FROM flow_runs WHERE id = ?", stepId);
    if (!record) throw new Error(`step ${stepId} not found`);
    return toStep(record);
  }

  skipRemainingSteps(jobId: string): void {
    // A throw mid-step (e.g. runJob's catch block) leaves the step that was
    // startStep'd but never finishStep'd sitting at status='running' under a
    // job that is about to become terminal. reconcileInterrupted() cannot
    // rescue it later - it only scans jobs still 'running', and this job is
    // about to be 'failed'. Close it here, in the same place that
    // already closes the steps behind it, or it stays 'running' forever.
    this.db.run(
      "UPDATE flow_runs SET status = 'failed', finished_at = ? WHERE job_id = ? AND status = 'running'",
      this.now(),
      jobId
    );
    this.db.run("UPDATE flow_runs SET status = 'skipped' WHERE job_id = ? AND status = 'queued'", jobId);
  }

  finishJob(id: string, status: "done" | "failed", error?: string): void {
    this.db.run(
      "UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?",
      status,
      error ?? null,
      this.now(),
      id
    );
  }

  /**
   * Atomically take the oldest queued job for `deviceId`, in one statement
   * (spec D-2): the sub-SELECT picks the candidate row, the trailing
   * `AND status = 'queued'` re-checks it at UPDATE time, and `RETURNING id`
   * hands back the claimed row's id from that same statement - so nothing
   * between the read and the write can be interleaved by another claimant. A
   * SELECT-then-UPDATE-by-id form is observably different here: it can lose
   * the row between the two statements and return `undefined` for a reason
   * indistinguishable from "queue empty", which is exactly the ambiguity
   * this single statement removes.
   *
   * Tiebreak on rowid, not id: id is `${createdAt}-${random}`, so an
   * id-based tiebreak orders same-millisecond jobs randomly - the same
   * reasoning listJobs already documents.
   *
   * `undefined` means nothing was claimed - today that only happens because
   * the queue is empty (this UPDATE and the dispatch loop that calls it both
   * run on the same synchronous, single-process `node:sqlite` handle, so a
   * lost race cannot happen yet). The post-UPDATE ownership check below
   * exists so that stays true if that assumption ever stops holding: the
   * caller should treat `undefined` as "try again later", never as "queue is
   * drained forever".
   */
  claimNextQueued(deviceId: string, singleDevice = false): JobRow | undefined {
    const startedAt = this.now();
    const won = this.db.get<{ id: string }>(
      `UPDATE jobs SET status = 'running', started_at = ?, device_id = ?
        WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND required_device_tags_json = '[]' AND isolation = 'disabled' ORDER BY created_at ASC, rowid ASC LIMIT 1)
          AND status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM maintenance_settings WHERE requested = 1)
          AND (? = 0 OR NOT EXISTS (SELECT 1 FROM jobs WHERE status = 'running'))
       RETURNING id`,
      startedAt,
      deviceId,
      singleDevice ? 1 : 0
    );
    if (!won) return undefined;

    const claimed = this.getJob(won.id);
    // Belt-and-braces: the row RETURNING just handed back should always be
    // ours, since the UPDATE that produced it and this read both run on the
    // same synchronous, single-process connection with nothing able to
    // interleave between them.
    if (!claimed || claimed.status !== "running" || claimed.deviceId !== deviceId) {
      // The UPDATE above already committed, so if we reach here the job is
      // stuck 'running' with a device_id set and nothing running it - a
      // permanently non-terminal job and a permanently leaked device. Log it
      // rather than returning silently, even though this branch is
      // unreachable under the documented single-process assumption.
      log.error("claimNextQueued: post-claim ownership check failed, job and device may be stranded", {
        jobId: won.id,
        deviceId,
      });
      return undefined;
    }
    return claimed;
  }

  /** Devices currently holding a running job. A device is free when it is
   * enrolled and absent from this list - derived, never leased, so a crashed
   * process strands no device. */
  runningDeviceIds(): string[] {
    return this.db
      .all<{ device_id: string }>(
        "SELECT DISTINCT device_id FROM jobs WHERE status = 'running' AND device_id IS NOT NULL"
      )
      .map((r) => r.device_id);
  }

  runningCount(): number {
    const row = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE status = 'running'");
    return row?.c ?? 0;
  }

  runningJobIds(): string[] { return this.db.all<{ id: string }>("SELECT id FROM jobs WHERE status='running'").map(row => row.id); }
  listQueuedJobs(): JobRow[] {
    return this.db.all<JobRecord>("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC, rowid ASC").map(toJob);
  }

  /** The edition chooses a compatible job synchronously, then atomically claims it. */
  claimQueuedJob(id: string, deviceId: string): JobRow | undefined {
    const won = this.db.get<{id: string}>(`UPDATE jobs SET status='running', started_at=?, device_id=?
      WHERE id=? AND status='queued'
      AND NOT EXISTS (SELECT 1 FROM maintenance_settings WHERE requested=1)
      AND EXISTS (SELECT 1 FROM devices WHERE id=? AND is_active=1)
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE device_id=? AND status='running')
      RETURNING id`, this.now(), deviceId, id, deviceId, deviceId);
    return won ? this.getJob(won.id) : undefined;
  }

  isMaintenanceRequested(): boolean { return this.db.get<{ requested: number }>('SELECT requested FROM maintenance_settings WHERE singleton=1')?.requested === 1; }
  setMaintenanceRequested(requested: boolean): void { this.db.run('UPDATE maintenance_settings SET requested=? WHERE singleton=1', requested ? 1 : 0); }

  /** The job claimNextQueued would take next - same ORDER BY, so the answer
   * never disagrees with what the scheduler actually does. Used to decide
   * whether a held device should start counting down its release. */
  oldestQueuedJobId(): string | undefined {
    return this.db.get<{ id: string }>(
      "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1"
    )?.id;
  }

  /**
   * Close jobs left mid-flight by a process that no longer exists. The update
   * timer restarts this service on every merge to main.
   *
   * Queued work is retained. Startup separately checks whether its durable
   * inputs exist, including migration from versions with transient uploads.
   *
   * A closed job keeps its device_id, which is what makes "which phone was
   * this on when the deploy killed it" answerable at all.
   */
  reconcileInterrupted(): number {
    const stranded = this.db.all<{ id: string }>("SELECT id FROM jobs WHERE status = 'running'");
    if (stranded.length === 0) return 0;

    const finishedAt = this.now();
    for (const { id } of stranded) {
      this.db.run(
        "UPDATE flow_runs SET status = 'failed', finished_at = ? WHERE job_id = ? AND status = 'running'",
        finishedAt,
        id
      );
      this.db.run("UPDATE flow_runs SET status = 'skipped' WHERE job_id = ? AND status = 'queued'", id);
      this.db.run(
        "UPDATE jobs SET status = 'failed', error = 'interrupted by restart', finished_at = ? WHERE id = ?",
        finishedAt,
        id
      );
    }

    return stranded.length;
  }

  /**
   * Close only queued jobs whose payload did not survive (e.g. old versions).
   * BOOT ONLY, before dispatch and submissions. Assumes one process per DATA_DIR.
   * The default preserves legacy callers; production supplies the input store.
   */
  failQueuedWithoutPayload(hasPayload: (id: string) => boolean = () => false): number {
    const stranded = this.db.all<{ id: string }>("SELECT id FROM jobs WHERE status = 'queued'").filter(({ id }) => !hasPayload(id));
    if (stranded.length === 0) return 0;

    const finishedAt = this.now();
    for (const { id } of stranded) {
      this.db.run("UPDATE flow_runs SET status = 'skipped' WHERE job_id = ? AND status = 'queued'", id);
      this.db.run(
        "UPDATE jobs SET status = 'failed', error = 'interrupted by restart', finished_at = ? WHERE id = ?",
        finishedAt,
        id
      );
    }

    return stranded.length;
  }

  /**
   * Whether a job is currently queued or running - used to guard disruptive
   * device operations (reboot, disable, remove) that would otherwise pull the
   * rug out from under an in-progress flow.
   *
   * With a device pool the farm-wide answer is too blunt: one org's job on
   * device A must not block a reboot of device B. Pass the device about to be
   * disrupted. A queued job belongs to no device yet, so the per-device form
   * deliberately only counts running work.
   */
  hasActiveJob(deviceId?: string): boolean {
    if (deviceId === undefined) {
      const row = this.db.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued', 'running')"
      );
      return (row?.c ?? 0) > 0;
    }
    const row = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM jobs WHERE status = 'running' AND device_id = ?",
      deviceId
    );
    return (row?.c ?? 0) > 0;
  }

  listJobs(org: string, limit = 100): JobRow[] {
    // Tiebreak on rowid, not id: id is `${createdAt}-${random suffix}`, so an
    // id-based tiebreak orders same-millisecond jobs randomly. SQLite's
    // implicit rowid increases with insertion order for free, giving a
    // correct and deterministic newest-first ordering even under ties.
    return this.db
      .all<JobRecord>(
        "SELECT * FROM jobs WHERE org = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        org,
        limit
      )
      .map(toJob);
  }

  recordArtifacts(flowRunId: number, artifacts: Array<{ kind: string; relPath: string; bytes: number }>): void {
    const createdAt = this.now();
    for (const artifact of artifacts) {
      this.db.run(
        "INSERT INTO artifacts (flow_run_id, kind, rel_path, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
        flowRunId,
        artifact.kind,
        artifact.relPath,
        artifact.bytes,
        createdAt
      );
    }
  }

  getArtifacts(flowRunId: number): ArtifactRow[] {
    return this.db
      .all<ArtifactRecord>("SELECT * FROM artifacts WHERE flow_run_id = ? ORDER BY id ASC", flowRunId)
      .map(toArtifact);
  }

  getArtifact(id: number): ArtifactRow | undefined {
    const record = this.db.get<ArtifactRecord>("SELECT * FROM artifacts WHERE id = ?", id);
    return record ? toArtifact(record) : undefined;
  }

  /** Total artifact bytes on disk, live and real-time. Retention now exists
   * (`src/retention.ts`'s sweep, admin-configurable, disabled by default)
   * but only runs periodically and only evicts once a threshold is crossed
   * - this number is independent of that and always reflects the current
   * total, which is still the ops panel's early warning if a threshold is
   * unset or set too loose. */
  totalArtifactBytes(): number {
    const row = this.db.get<{ total: number | null }>("SELECT SUM(bytes) AS total FROM artifacts");
    return row?.total ?? 0;
  }

  /** Undefined until an admin has ever saved settings - callers (the
   * retention sweep, the admin API) treat a missing row identically to an
   * all-disabled one. */
  getRetentionSettings(): RetentionSettingsRow | undefined {
    const record = this.db.get<RetentionSettingsRecord>("SELECT * FROM retention_settings WHERE id = 1");
    return record ? toRetentionSettings(record) : undefined;
  }

  setRetentionSettings(settings: {
    maxAgeDays: number | null;
    maxTotalBytes: number | null;
    maxJobs: number | null;
  }): RetentionSettingsRow {
    const updatedAt = this.now();
    this.db.run(
      `INSERT INTO retention_settings (id, max_age_days, max_total_bytes, max_jobs, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         max_age_days = excluded.max_age_days,
         max_total_bytes = excluded.max_total_bytes,
         max_jobs = excluded.max_jobs,
         updated_at = excluded.updated_at`,
      settings.maxAgeDays,
      settings.maxTotalBytes,
      settings.maxJobs,
      updatedAt
    );
    const saved = this.getRetentionSettings();
    if (!saved) throw new Error("retention settings vanished immediately after insert");
    return saved;
  }

  /** Undefined until an admin has ever saved an upload limit. The absence of
   * the row is meaningful: it means "never configured", which
   * effectiveUploadLimit turns into DEFAULT_MAX_UPLOAD_BYTES. A row whose
   * max_upload_bytes is null means an admin deliberately chose "no limit". */
  getUploadSettings(): UploadSettingsRow | undefined {
    const record = this.db.get<UploadSettingsRecord>("SELECT * FROM upload_settings WHERE id = 1");
    return record ? { maxUploadBytes: record.max_upload_bytes, updatedAt: record.updated_at } : undefined;
  }

  setUploadSettings(settings: { maxUploadBytes: number | null }): UploadSettingsRow {
    const updatedAt = this.now();
    this.db.run(
      `INSERT INTO upload_settings (id, max_upload_bytes, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         max_upload_bytes = excluded.max_upload_bytes,
         updated_at = excluded.updated_at`,
      settings.maxUploadBytes,
      updatedAt
    );
    const saved = this.getUploadSettings();
    if (!saved) throw new Error("upload settings vanished immediately after insert");
    return saved;
  }

  getSchedulerSettings(): SchedulerSettingsRow | undefined {
    const record = this.db.get<SchedulerSettingsRecord>("SELECT * FROM scheduler_settings WHERE id = 1");
    return record ? { maxConcurrentJobs: record.max_concurrent_jobs, updatedAt: record.updated_at } : undefined;
  }

  setSchedulerSettings(settings: { maxConcurrentJobs: number | null }): SchedulerSettingsRow {
    this.db.run(
      `INSERT INTO scheduler_settings (id, max_concurrent_jobs, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET max_concurrent_jobs = excluded.max_concurrent_jobs,
                                     updated_at = excluded.updated_at`,
      settings.maxConcurrentJobs,
      this.now()
    );
    const saved = this.getSchedulerSettings();
    if (!saved) throw new Error("scheduler settings vanished immediately after insert");
    return saved;
  }

  /**
   * The cap to enforce right now, in bytes, or null for no limit.
   *
   * The whole three-state rule lives here so no caller re-derives it:
   *
   *   no row          -> DEFAULT_MAX_UPLOAD_BYTES  (never configured)
   *   integer         -> that value
   *   row, null value -> null                      (admin chose unlimited)
   *
   * The "never configured" case must default to *protected*, not unlimited:
   * every existing deployment picks up the cap on deploy without an admin
   * touching anything, and nobody opts into a limit they have not yet been
   * bitten by.
   */
  effectiveUploadLimit(): number | null {
    const settings = this.getUploadSettings();
    if (!settings) return DEFAULT_MAX_UPLOAD_BYTES;
    return settings.maxUploadBytes;
  }

  /**
   * Every job not currently queued/running, oldest first, each with its
   * total artifact bytes (0 if it has none) - the shape the retention sweep
   * (src/retention.ts) needs to evaluate every threshold kind without a
   * separate query per threshold.
   */
  listEvictableJobs(): EvictableJobRow[] {
    return this.db
      .all<{ id: string; created_at: number; bytes: number | null }>(
        `SELECT j.id AS id, j.created_at AS created_at, COALESCE(SUM(a.bytes), 0) AS bytes
         FROM jobs j
         LEFT JOIN flow_runs f ON f.job_id = j.id
         LEFT JOIN artifacts a ON a.flow_run_id = f.id
         WHERE j.status IN ('done', 'failed')
         GROUP BY j.id
         ORDER BY j.created_at ASC`
      )
      .map((r) => ({ id: r.id, createdAt: r.created_at, bytes: r.bytes ?? 0 }));
  }

  /** Deletes a job's row, cascading to flow_runs -> artifacts. Callers must
   * remove the artifact files from disk themselves FIRST (retention.ts
   * does) - this method only ever touches the database. */
  deleteJob(id: string): void {
    this.db.run("DELETE FROM jobs WHERE id = ?", id);
  }
}
