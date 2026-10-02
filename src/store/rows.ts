export type JobStatus = "queued" | "running" | "done" | "failed";
export type StepStatus = "queued" | "running" | "passed" | "failed" | "skipped";
export type StepKind = "setup" | "flow";
// "log" covers maestro.log: Maestro 2.6.1 writes it alongside screenshots and
// commands JSON in its debug output, and it is the single most useful
// artifact when diagnosing a failed flow - dropping it (as an earlier
// mapping did by only recognising image/video/json/xml extensions) would
// defeat a primary purpose of collecting artifacts at all.
export type ArtifactKind = "screenshot" | "recording" | "hierarchy" | "stdout" | "stderr" | "log";

export interface JobRow {
  id: string;
  org: string;
  status: JobStatus;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** The env the caller supplied, JSON, with secret values already replaced
   * by REDACTED. Null when the caller sent no env field at all. */
  envJson: string | null;
  /** The device this job was claimed by, set when the scheduler starts it.
   * Null while queued, and null for any job that ran before cycle 10 or whose
   * device row has since been removed. */
  deviceId: string | null;
  /** The Android package name resolved from the uploaded APK's manifest at
   * submit time. Null for any job that ran before this column existed, or
   * whenever app-id resolution isn't wired up (e.g. a test double). */
  appId: string | null;
  /** "versionName (versionCode)", just versionName, or null - see
   * src/appId.ts's formatAppVersion for the exact rule. */
  appVersion: string | null;
}

export interface StepRow {
  id: number;
  jobId: string;
  ordinal: number;
  kind: StepKind;
  name: string;
  status: StepStatus;
  exitCode: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  resolvedPath: string | null;
  artifactDir: string | null;
  warnings: string[];
  stdoutPreview: string | null;
  stderrPreview: string | null;
}

export interface ArtifactRow {
  id: number;
  flowRunId: number;
  kind: ArtifactKind;
  relPath: string;
  bytes: number;
  createdAt: number;
}

export interface RetentionSettingsRow {
  maxAgeDays: number | null;
  maxTotalBytes: number | null;
  maxJobs: number | null;
  updatedAt: number;
}

/** Server-wide upload cap. `maxUploadBytes` null means an admin explicitly
 * chose "no limit"; the absence of the row entirely means "never configured",
 * which yields DEFAULT_MAX_UPLOAD_BYTES instead. */
export interface UploadSettingsRow {
  maxUploadBytes: number | null;
  updatedAt: number;
}

/** Server-wide concurrency cap. `maxConcurrentJobs` null - and the absence of
 * the row entirely - both mean "no cap": the scheduler runs one job per
 * enrolled device and nothing further limits it. */
export interface SchedulerSettingsRow {
  maxConcurrentJobs: number | null;
  updatedAt: number;
}

export interface EvictableJobRow {
  id: string;
  createdAt: number;
  bytes: number;
}

export type DeviceEventKind =
  | "added"
  | "activated"
  | "enabled"
  | "disabled"
  | "removed"
  | "state_change"
  | "reboot"
  | "screenshot"
  /** An admin's live view of this device's screen started or ended. */
  | "control"
  /** The device's reset policy changed. Recorded because the stronger policy
   * deletes browsing data on the next job. */
  | "reset_policy"
  /** The device's display name changed. */
  | "renamed";

/**
 * How thoroughly a device resets itself before each job.
 *
 * A property of the device, never of a job: flows must run byte-identical
 * against DeviceCloud and DeviceYard, so this must not reach the job API.
 *
 *   app-only        today's behaviour - force-stop and `pm clear` the app
 *                   under test, and nothing else. The default, because the
 *                   farm's handset holds a real person's data.
 *   app-and-browser additionally clears the browser serving Custom Tabs,
 *                   which is where Apple and Facebook keep their sessions.
 *                   Destructive on a device with real browsing data.
 */
export type ResetPolicy = "app-only" | "app-and-browser";

export const RESET_POLICIES: readonly ResetPolicy[] = ["app-only", "app-and-browser"];

export function isResetPolicy(value: unknown): value is ResetPolicy {
  return typeof value === "string" && (RESET_POLICIES as readonly string[]).includes(value);
}

export interface DeviceRow {
  id: string;
  label: string;
  model: string | null;
  isActive: boolean;
  addedAt: number;
  resetPolicy: ResetPolicy;
}

export interface DeviceEventRow {
  id: number;
  deviceId: string;
  kind: DeviceEventKind;
  detail: string;
  createdAt: number;
}

export interface UserRow {
  id: number;
  username: string;
  email: string;
  isAdmin: boolean;
  deactivatedAt: number | null;
  createdAt: number;
}

export interface OrgRow {
  id: number;
  name: string;
  archivedAt: number | null;
  createdAt: number;
}

/** value is always the decrypted, plaintext token - OrgTokenRepository never
 * returns the encrypted form to a caller. */
export interface OrgTokenRow {
  id: number;
  orgId: number;
  label: string;
  value: string;
  createdAt: number;
  createdByUserId: number | null;
}

export interface UserTokenRow {
  id: number;
  userId: number;
  label: string;
  value: string;
  createdAt: number;
  /** Null until the token authenticates a request. A PAT is long-lived and
   * personal, so "when did this last get used" is the question its owner
   * asks before revoking one. */
  lastUsedAt: number | null;
}
