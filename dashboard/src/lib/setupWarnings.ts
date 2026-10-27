import type { DeviceEntry } from "./api";

/** One setup check that reads as not applied on one device. */
export interface SetupWarning {
  deviceId: string;
  deviceLabel: string;
  checkId: string;
  title: string;
  detail: string;
}

// Per browser on purpose: hiding the bar is a viewer's choice not to act on
// the warning, not a farm-wide decision - the device card keeps showing it.
const STORAGE_KEY = "deviceyard-dismissed-setup-checks";

export function warningKey(warning: SetupWarning): string {
  return `${warning.deviceId}:${warning.checkId}`;
}

/** Only `ok === false` warns (`null` = unreadable), and devices the edition
 * does not allow are skipped: their fix route can only answer 409. */
export function pendingSetupWarnings(devices: readonly DeviceEntry[]): SetupWarning[] {
  return devices
    .filter((device) => device.isAvailable !== false)
    .flatMap((device) =>
      (device.setupChecks ?? [])
        .filter((check) => check.ok === false)
        .map((check) => ({
          deviceId: device.id,
          deviceLabel: device.label,
          checkId: check.id,
          title: check.title,
          detail: check.detail,
        }))
    );
}

/** Drops dismissals for checks that now read as applied, so a setting that
 * is fixed and later switched back on (Google Play services can do that)
 * warns again. Returns the same set when nothing changed. */
export function pruneDismissed(dismissed: ReadonlySet<string>, devices: readonly DeviceEntry[]): ReadonlySet<string> {
  const applied = new Set(
    devices.flatMap((device) =>
      (device.setupChecks ?? []).filter((check) => check.ok === true).map((check) => `${device.id}:${check.id}`)
    )
  );
  if (![...dismissed].some((key) => applied.has(key))) return dismissed;
  return new Set([...dismissed].filter((key) => !applied.has(key)));
}

export function visibleWarnings(warnings: readonly SetupWarning[], dismissed: ReadonlySet<string>): SetupWarning[] {
  return warnings.filter((warning) => !dismissed.has(warningKey(warning)));
}

export function loadDismissed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveDismissed(dismissed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...dismissed]));
  } catch {
    // Without storage the bar still hides for this page view.
  }
}
