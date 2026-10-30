import type { CommandRunner } from "./maestro";
import { createRunner } from "./maestro";
import type { DeviceRepository } from "./store/deviceRepository";
import { log } from "./telemetry/log";

/** Every farm-created Android user is named with this prefix. Nothing else is ever removed. */
export const FARM_PROFILE_PREFIX = "deviceyard-";

/** UserInfo.FLAG_MANAGED_PROFILE: a work profile (corporate or ours). */
export const FLAG_MANAGED_PROFILE = 0x20;

/**
 * Creating/removing a user takes seconds, not minutes; a profile command that
 * hangs should fail well before a Maestro flow's budget. Exported with its
 * runner because the Pro isolation hooks use the same one.
 */
export const PROFILE_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
export const profileRunner: CommandRunner = createRunner(PROFILE_COMMAND_TIMEOUT_MS);

export interface AndroidUser {
  id: number;
  name: string;
  flags: number;
}

export function farmProfileName(jobId: string, ordinal?: number): string {
  return `${FARM_PROFILE_PREFIX}${jobId}${ordinal === undefined ? "" : `-${ordinal}`}`;
}

export function parseUsers(stdout: string): AndroidUser[] {
  const users: AndroidUser[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*UserInfo\{(\d+):([^:]*):([0-9a-fA-F]+)\}(\s|$)/.exec(line);
    if (m) users.push({ id: Number(m[1]), name: m[2], flags: parseInt(m[3], 16) });
  }
  return users;
}

/** The only users the farm may remove. User 0 (the owner) is excluded unconditionally. */
export function isFarmProfile(u: AndroidUser): boolean {
  return u.id !== 0 && u.name.startsWith(FARM_PROFILE_PREFIX);
}

async function listUsers(deviceId: string, runner: CommandRunner): Promise<AndroidUser[]> {
  const r = await runner("adb", ["-s", deviceId, "shell", "pm", "list", "users"]);
  if (r.code !== 0) throw new Error(`pm list users exited with ${r.code}`);
  return parseUsers(r.stdout);
}

export async function removeFarmProfiles(
  deviceId: string,
  runner: CommandRunner = profileRunner,
  isDeviceBusy: (deviceId: string) => boolean = () => false
): Promise<{ removed: number[]; warnings: string[] }> {
  const removed: number[] = [];
  const warnings: string[] = [];
  let users: AndroidUser[];
  try {
    users = await listUsers(deviceId, runner);
  } catch (err) {
    return { removed, warnings: [`could not list users: ${(err as Error).message}`] };
  }
  for (const u of users.filter(isFarmProfile)) {
    // Checked per user, right before each removal, so a job that claims the
    // device mid-cleanup keeps its own profile (its per-job cleanup owns it).
    if (isDeviceBusy(deviceId)) {
      warnings.push("device is busy: leftover profiles left to the job's own cleanup");
      break;
    }
    try {
      const r = await runner("adb", ["-s", deviceId, "shell", "pm", "remove-user", String(u.id)]);
      if (r.code === 0) removed.push(u.id);
      else warnings.push(`could not remove user ${u.id}: exit ${r.code}`);
    } catch (err) {
      warnings.push(`could not remove user ${u.id}: ${(err as Error).message}`);
    }
  }
  return { removed, warnings };
}

/** true / false, or null when it could not be read (never a guess). */
export async function probeIsolationCapability(
  deviceId: string,
  runner: CommandRunner = profileRunner
): Promise<boolean | null> {
  try {
    const f = await runner("adb", ["-s", deviceId, "shell", "pm", "list", "features"]);
    if (f.code !== 0) return null;
    const users = await listUsers(deviceId, runner);
    if (!f.stdout.includes("feature:android.software.managed_users")) return false;
    return !users.some((u) => !isFarmProfile(u) && (u.flags & FLAG_MANAGED_PROFILE) !== 0);
  } catch {
    return null;
  }
}

export async function cleanUpFarmProfilesAtStartup(
  devices: DeviceRepository,
  runner: CommandRunner = profileRunner,
  isDeviceBusy: (deviceId: string) => boolean = () => false
): Promise<void> {
  let list;
  try {
    list = devices.list();
  } catch (err) {
    log.warn("work profile startup cleanup could not list devices", { error: (err as Error).message });
    return;
  }
  for (const device of list) {
    try {
      // Capability first: it ignores farm leftovers, so order does not change
      // the result, but reading before removing keeps a removal failure from
      // hiding the capability.
      const capable = await probeIsolationCapability(device.id, runner);
      const { removed, warnings } = await removeFarmProfiles(device.id, runner, isDeviceBusy);
      if (capable !== null) devices.setIsolationCapable(device.id, capable);
      if (removed.length || warnings.length) {
        log.info("work profile startup cleanup", { deviceId: device.id, removed: removed.length, warnings: warnings.length });
      }
    } catch (err) {
      log.warn("work profile startup cleanup failed for device", { deviceId: device.id, error: (err as Error).message });
    }
  }
}
