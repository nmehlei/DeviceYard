// Local mirrors of the farm's HTTP response shapes, transcribed from
// src/store/rows.ts and the route handlers in src/api/. Deliberately NOT
// imported from src/store/*: shared/ never imports from src/, which is what
// lets the CLI be published without dragging the server's storage layer with
// it. Both consumers - src/mcp/ and cli/ - depend on these shapes being
// right, and the integration tests on each side are what catch a drift.

import type { IsolationMode } from "./isolation";

export type JobStatus = "queued" | "running" | "done" | "failed";
export type StepStatus = "queued" | "running" | "passed" | "failed" | "skipped";
export type StepKind = "setup" | "flow";
export type ArtifactKind = "screenshot" | "recording" | "hierarchy" | "stdout" | "stderr" | "log";

export interface ArtifactRow {
  id: number;
  flowRunId: number;
  kind: ArtifactKind;
  relPath: string;
  bytes: number;
  createdAt: number;
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
  profileMs?: number | null;
  /** Added by GET /api/jobs/:id on top of the stored row. */
  artifacts?: ArtifactRow[];
}

export interface JobRow {
  isolation?: IsolationMode;
  requiredDeviceTags?: string[];
  waitingReason?: string | null;
  id: string;
  org: string;
  status: JobStatus;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  appId: string | null;
  appVersion: string | null;
}

export interface JobDetail {
  job: JobRow;
  steps: StepRow[];
}

/** GET /api/jobs annotates each job with a progress summary computed over
 * its `kind === "flow"` steps only. */
export interface JobSummary extends JobRow {
  flowCount: number;
  passed: number;
  failed: number;
  running: number;
}

export interface JobListResponse {
  jobs: JobSummary[];
}

export interface DeviceEntry {
  tags?: string[];
  id: string;
  label: string;
  model: string | null;
  /** Enrolled in the pool and accepting work - not "the" active device. */
  isActive: boolean;
  /** Live adb state: "device", "offline", "unauthorized", ... */
  state: string;
  /** Device settings DeviceYard depends on. `ok: null` = could not be read
   * (device not online, or the read failed) - not a warning. */
  setupChecks?: { id: string; title: string; detail: string; ok: boolean | null }[];
}

/** GET /api/devices - note the plural. There is no /api/device route. */
export interface DeviceResponse {
  devices: DeviceEntry[];
  runnerVersion: string;
  /** Farm-wide total, reported once - not per device. */
  artifactBytes: number;
}

export interface VersionResponse {
  version: string;
  maestroVersion?: string;
}

/** POST /run */
export interface RunResponse {
  id: string;
  status: string;
  /** Only present for per-flow isolation. */
  warnings?: string[];
}
