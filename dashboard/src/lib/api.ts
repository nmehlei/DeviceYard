// Typed client for the cycle-1 dashboard API (README.md, "Dashboard API").
// Every function takes an injectable fetchImpl, defaulting to the global -
// the same dependency-injection pattern the runner uses for CommandRunner,
// and what makes these testable without a live server.

import { getActiveOrgId, setActiveOrgId, clearActiveOrgId, orgScopedFetch } from "./activeOrg";

export type JobStatus = "queued" | "running" | "done" | "failed";
export interface MaintenanceStatus {
  requested: boolean;
  state: 'normal' | 'draining' | 'ready';
  runningJobs: number;
  activeOperations: number;
  activeStreams: number;
}
export async function fetchMaintenance(fetchImpl: typeof fetch = fetch): Promise<MaintenanceStatus> {
  const response = await fetchImpl('/api/maintenance', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw await apiErrorFrom(response, 'Could not refresh maintenance status');
  return parseJson<MaintenanceStatus>(response);
}
export async function setMaintenance(requested: boolean, fetchImpl: typeof fetch = fetch): Promise<MaintenanceStatus> {
  const response = await fetchImpl('/api/admin/maintenance', {
    method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requested }),
  });
  if (!response.ok) throw await apiErrorFrom(response, 'Could not change maintenance mode');
  return parseJson<MaintenanceStatus>(response);
}
export type StepStatus = "queued" | "running" | "passed" | "failed" | "skipped";
export type StepKind = "setup" | "flow";
export type ArtifactKind = "screenshot" | "recording" | "hierarchy" | "stdout" | "stderr" | "log";

export interface JobRow {
  requiredDeviceTags?: string[];
  waitingReason?: string | null;
  id: string;
  org: string;
  status: JobStatus;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  deviceId: string | null;
  appId: string | null;
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

export interface JobListEntry extends JobRow {
  flowCount: number;
  passed: number;
  failed: number;
  running: number;
}

export interface StepWithArtifacts extends StepRow {
  artifacts: ArtifactRow[];
}

export interface JobDetail {
  job: JobRow;
  steps: StepWithArtifacts[];
}

export type DeviceEventKind =
  | "added"
  | "activated"
  | "state_change"
  | "reboot"
  | "screenshot"
  | "reset_policy"
  | "setup_fix";

/** A device setting DeviceYard depends on (server: src/deviceSetupChecks.ts).
 * `ok: null` = could not be read; only `false` is a warning. */
export interface DeviceSetupCheckEntry {
  id: string;
  title: string;
  detail: string;
  ok: boolean | null;
}

/** How thoroughly the device scrubs itself before each job. Set per device,
 * never per job: flows must be identical against DeviceCloud and DeviceYard. */
export type ResetPolicy = "app-only" | "app-and-browser";

export interface DeviceEntry {
  tags?: string[];
  isAvailable?: boolean;
  edition?: 'community' | 'pro';
  id: string;
  label: string;
  model: string | null;
  isActive: boolean;
  /** Live adb state for this poll: "device" (online/authorized), "unauthorized",
   * or "offline" (not currently attached - the row itself is never removed). */
  state: string;
  resetPolicy: ResetPolicy;
  /** Optional so fixtures and older runners without it still type-check. */
  setupChecks?: DeviceSetupCheckEntry[];
}

export interface DeviceEventEntry {
  id: number;
  deviceId: string;
  kind: DeviceEventKind;
  detail: string;
  createdAt: number;
}

export interface User {
  id: number;
  username: string;
  email: string;
  isAdmin: boolean;
}

export interface Org {
  id: number;
  name: string;
  archivedAt: number | null;
  createdAt: number;
}

export interface OrgToken {
  id: number;
  orgId: number;
  label: string;
  value: string;
  createdAt: number;
  createdByUserId: number | null;
}

export interface UserToken {
  id: number;
  userId: number;
  label: string;
  value: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface SessionInfo {
  user: User;
  orgs: Org[];
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Shared by login()/fetchSession(): reconcile the stored active-org id
 * against this response's actual org list. A stored id that isn't in the
 * list is stale - either left behind by a previous user on this tab (sign
 * out, a different user signs in) or a user removed from their
 * currently-active org - and must be cleared before falling back to the
 * existing "pick orgs[0] if any" default, or every subsequent org-scoped
 * request silently keeps carrying an id that no longer means anything for
 * the now-current user. */
function reconcileActiveOrg(orgs: SessionInfo["orgs"]): void {
  const current = getActiveOrgId();
  if (current !== undefined && !orgs.some((org) => org.id === current)) {
    clearActiveOrgId();
  }
  if (getActiveOrgId() === undefined && orgs.length > 0) setActiveOrgId(orgs[0].id);
}

export async function login(
  username: string,
  password: string,
  fetchImpl: typeof fetch = fetch
): Promise<SessionInfo> {
  const res = await fetchImpl("/api/session", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new ApiError(res.status, "login failed");
  const info = await parseJson<SessionInfo>(res);
  // Pick a default active org for this tab immediately - without this, the
  // very next page load's job-scoped fetches would go out with no X-Org-Id
  // header and silently show nothing. Also resets a stale org id left over
  // from a previous user on this same tab (see reconcileActiveOrg above).
  reconcileActiveOrg(info.orgs);
  return info;
}

export async function fetchSession(fetchImpl: typeof fetch = fetch): Promise<SessionInfo> {
  const res = await fetchImpl("/api/session", { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "not logged in");
  const info = await parseJson<SessionInfo>(res);
  reconcileActiveOrg(info.orgs);
  return info;
}

export async function logout(fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl("/api/session", { method: "DELETE", credentials: "include" });
  // Always clear the active org on logout, even if the request itself
  // failed - a stale org id must never survive past sign-out into whoever
  // signs in next on this tab.
  clearActiveOrgId();
  if (!res.ok && res.status !== 204) throw new ApiError(res.status, "logout failed");
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const res = await fetchImpl("/api/session/password", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  // apiErrorFrom, not a generic message: "current password is incorrect" and
  // the length requirement are both things the form should show inline, not
  // flatten into one generic failure.
  if (!res.ok) throw await apiErrorFrom(res, "failed to change password");
}

export async function fetchOrgMembers(orgId: number, fetchImpl: typeof fetch = fetch): Promise<User[]> {
  const res = await fetchImpl(`/api/orgs/${orgId}/members`, { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to load org members");
  const body = await parseJson<{ members: User[] }>(res);
  return body.members;
}

export async function addOrgMember(orgId: number, userId: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`/api/orgs/${orgId}/members`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new ApiError(res.status, "failed to add member");
}

export async function removeOrgMember(orgId: number, userId: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`/api/orgs/${orgId}/members/${userId}`, { method: "DELETE", credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to remove member");
}

export async function fetchOrgTokens(orgId: number, fetchImpl: typeof fetch = fetch): Promise<OrgToken[]> {
  const res = await fetchImpl(`/api/orgs/${orgId}/tokens`, { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to load org tokens");
  const body = await parseJson<{ tokens: OrgToken[] }>(res);
  return body.tokens;
}

export async function createOrgToken(orgId: number, label: string, fetchImpl: typeof fetch = fetch): Promise<OrgToken> {
  const res = await fetchImpl(`/api/orgs/${orgId}/tokens`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new ApiError(res.status, "failed to create token");
  const body = await parseJson<{ token: OrgToken }>(res);
  return body.token;
}

export async function revokeOrgToken(orgId: number, tokenId: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`/api/orgs/${orgId}/tokens/${tokenId}`, { method: "DELETE", credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to revoke token");
}

export async function fetchMyTokens(fetchImpl: typeof fetch = fetch): Promise<UserToken[]> {
  const res = await fetchImpl("/api/me/tokens", { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to load personal tokens");
  const body = await parseJson<{ tokens: UserToken[] }>(res);
  return body.tokens;
}

export async function createMyToken(label: string, fetchImpl: typeof fetch = fetch): Promise<UserToken> {
  const res = await fetchImpl("/api/me/tokens", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new ApiError(res.status, "failed to create token");
  const body = await parseJson<{ token: UserToken }>(res);
  return body.token;
}

export async function revokeMyToken(tokenId: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`/api/me/tokens/${tokenId}`, { method: "DELETE", credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to revoke token");
}

export async function adminListOrgs(fetchImpl: typeof fetch = fetch): Promise<Org[]> {
  const res = await fetchImpl("/api/admin/orgs", { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to load orgs");
  const body = await parseJson<{ orgs: Org[] }>(res);
  return body.orgs;
}

export async function adminCreateOrg(name: string, fetchImpl: typeof fetch = fetch): Promise<Org> {
  const res = await fetchImpl("/api/admin/orgs", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new ApiError(res.status, "failed to create org");
  const body = await parseJson<{ org: Org }>(res);
  return body.org;
}

export async function adminRenameOrg(id: number, name: string, fetchImpl: typeof fetch = fetch): Promise<Org> {
  const res = await fetchImpl(`/api/admin/orgs/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new ApiError(res.status, "failed to rename org");
  const body = await parseJson<{ org: Org }>(res);
  return body.org;
}

export async function adminArchiveOrg(id: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`/api/admin/orgs/${id}`, { method: "DELETE", credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to archive org");
}

export async function adminListUsers(fetchImpl: typeof fetch = fetch): Promise<User[]> {
  const res = await fetchImpl("/api/admin/users", { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to load users");
  const body = await parseJson<{ users: User[] }>(res);
  return body.users;
}

export async function adminCreateUser(
  username: string,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch
): Promise<User> {
  const res = await fetchImpl("/api/admin/users", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  if (!res.ok) throw new ApiError(res.status, "failed to create user");
  const body = await parseJson<{ user: User }>(res);
  return body.user;
}

export async function adminEditUser(
  id: number,
  changes: { isAdmin?: boolean; password?: string },
  fetchImpl: typeof fetch = fetch
): Promise<User> {
  const res = await fetchImpl(`/api/admin/users/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  if (!res.ok) throw new ApiError(res.status, "failed to edit user");
  const body = await parseJson<{ user: User }>(res);
  return body.user;
}

export async function adminDeactivateUser(id: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`/api/admin/users/${id}`, { method: "DELETE", credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to deactivate user");
}

export interface RetentionSettings {
  maxAgeDays: number | null;
  maxTotalBytes: number | null;
  maxJobs: number | null;
  totalArtifactBytes: number;
}

export async function fetchRetentionSettings(fetchImpl: typeof fetch = fetch): Promise<RetentionSettings> {
  const res = await fetchImpl("/api/admin/retention", { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to load retention settings");
  return parseJson<RetentionSettings>(res);
}

export async function updateRetentionSettings(
  settings: { maxAgeDays: number | null; maxTotalBytes: number | null; maxJobs: number | null },
  fetchImpl: typeof fetch = fetch
): Promise<RetentionSettings> {
  const res = await fetchImpl("/api/admin/retention", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to save retention settings");
  return parseJson<RetentionSettings>(res);
}

export interface UploadSettings {
  /** What is stored: null means an admin explicitly chose "no limit". */
  maxUploadBytes: number | null;
  /** What POST /run enforces right now - the default when nothing is stored. */
  effectiveMaxUploadBytes: number | null;
  defaultMaxUploadBytes: number;
}

export async function fetchUploadSettings(fetchImpl: typeof fetch = fetch): Promise<UploadSettings> {
  const res = await fetchImpl("/api/admin/upload", { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to load the upload limit");
  return parseJson<UploadSettings>(res);
}

export async function updateUploadSettings(
  settings: { maxUploadBytes: number | null },
  fetchImpl: typeof fetch = fetch
): Promise<UploadSettings> {
  const res = await fetchImpl("/api/admin/upload", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to save the upload limit");
  return parseJson<UploadSettings>(res);
}

export async function fetchJobs(limit = 50, fetchImpl: typeof fetch = orgScopedFetch()): Promise<JobListEntry[]> {
  const res = await fetchImpl(`/api/jobs?limit=${limit}`, { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to load jobs");
  const body = await parseJson<{ jobs: JobListEntry[] }>(res);
  return body.jobs;
}

export async function fetchJobDetail(
  id: string,
  fetchImpl: typeof fetch = orgScopedFetch()
): Promise<JobDetail | undefined> {
  const res = await fetchImpl(`/api/jobs/${encodeURIComponent(id)}`, { credentials: "include" });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new ApiError(res.status, "failed to load job");
  return parseJson<JobDetail>(res);
}

/** Reads {error} out of a failed response's body when present, falling back
 * to a generic message when the body isn't JSON or carries no such field. */
async function apiErrorFrom(res: Response, fallback: string): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string" && body.error) return new ApiError(res.status, body.error);
  } catch {
    // body wasn't JSON - fall through to the generic message
  }
  return new ApiError(res.status, fallback);
}

export interface SchedulerSettings {
  maxConcurrentJobs: number | null;
}

export async function fetchSchedulerSettings(fetchImpl: typeof fetch = fetch): Promise<SchedulerSettings> {
  const res = await fetchImpl("/api/admin/scheduler", { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "failed to load scheduler settings");
  return parseJson<SchedulerSettings>(res);
}

export async function updateSchedulerSettings(
  settings: { maxConcurrentJobs: number | null },
  fetchImpl: typeof fetch = fetch
): Promise<SchedulerSettings> {
  const res = await fetchImpl("/api/admin/scheduler", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to save scheduler settings");
  return parseJson<SchedulerSettings>(res);
}

export async function fetchDevices(
  fetchImpl: typeof fetch = fetch
): Promise<{ devices: DeviceEntry[]; runnerVersion: string; artifactBytes: number }> {
  const res = await fetchImpl("/api/devices", { credentials: "include" });
  if (!res.ok) throw await apiErrorFrom(res, "failed to load devices");
  return parseJson(res);
}

export interface VersionInfo {
  version: string;
  edition?: "community" | "pro";
  coreVersion?: string;
  revisions?: { core?: string; pro?: string };
  maestroVersion: string;
  maestroPending?: boolean;
}

export async function fetchVersion(fetchImpl: typeof fetch = fetch): Promise<VersionInfo> {
  const res = await fetchImpl("/api/version?waitForMaestro=false", { credentials: "include" });
  if (!res.ok) throw await apiErrorFrom(res, "failed to load version");
  return parseJson<VersionInfo>(res);
}

export async function addDevice(
  id: string,
  label: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ device: DeviceEntry; setupInstructions: string[] }> {
  const res = await fetchImpl("/api/devices", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, label }),
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to add device");
  return parseJson(res);
}

export async function activateDevice(id: string, fetchImpl: typeof fetch = fetch): Promise<DeviceEntry> {
  const res = await fetchImpl(`/api/devices/${encodeURIComponent(id)}/activate`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to activate device");
  const body = await parseJson<{ device: DeviceEntry }>(res);
  return body.device;
}

export async function enableDevice(id: string, fetchImpl: typeof fetch = fetch): Promise<DeviceEntry> {
  const res = await fetchImpl(`/api/devices/${encodeURIComponent(id)}/enable`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to enable device");
  const body = await parseJson<{ device: DeviceEntry }>(res);
  return body.device;
}

export async function disableDevice(id: string, fetchImpl: typeof fetch = fetch): Promise<DeviceEntry> {
  const res = await fetchImpl(`/api/devices/${encodeURIComponent(id)}/disable`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to disable device");
  const body = await parseJson<{ device: DeviceEntry }>(res);
  return body.device;
}

export async function renameDevice(
  id: string,
  label: string,
  fetchImpl: typeof fetch = fetch
): Promise<DeviceEntry> {
  const res = await fetchImpl(`/api/devices/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to rename the device");
  const body = await parseJson<{ device: DeviceEntry }>(res);
  return body.device;
}

export async function setDeviceResetPolicy(
  id: string,
  resetPolicy: ResetPolicy,
  fetchImpl: typeof fetch = fetch
): Promise<DeviceEntry> {
  const res = await fetchImpl(`/api/devices/${encodeURIComponent(id)}/reset-policy`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resetPolicy }),
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to change the reset policy");
  const body = await parseJson<{ device: DeviceEntry }>(res);
  return body.device;
}

export async function removeDevice(id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`/api/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to remove device");
}

export async function rebootDevice(id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`/api/devices/${encodeURIComponent(id)}/reboot`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to reboot device");
}

export async function fixDeviceSetupCheck(id: string, checkId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(
    `/api/devices/${encodeURIComponent(id)}/setup-checks/${encodeURIComponent(checkId)}/fix`,
    { method: "POST", credentials: "include" }
  );
  if (!res.ok) throw await apiErrorFrom(res, "failed to fix the device setting");
}

export async function fetchDeviceEvents(
  id: string,
  limit = 30,
  fetchImpl: typeof fetch = fetch
): Promise<DeviceEventEntry[]> {
  const res = await fetchImpl(`/api/devices/${encodeURIComponent(id)}/events?limit=${limit}`, {
    credentials: "include",
  });
  if (!res.ok) throw await apiErrorFrom(res, "failed to load device events");
  const body = await parseJson<{ events: DeviceEventEntry[] }>(res);
  return body.events;
}

/** Returns an object URL for the captured PNG - caller owns it and must
 * URL.revokeObjectURL it when done (e.g. on unmount or before the next shot). */
export async function takeDeviceScreenshot(id: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`/api/devices/${encodeURIComponent(id)}/screenshot`, { credentials: "include" });
  if (!res.ok) throw await apiErrorFrom(res, "failed to capture screenshot");
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
