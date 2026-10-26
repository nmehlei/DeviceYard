"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { fetchDevices, type DeviceEntry } from "../lib/api";
import { usePolledDevices } from "../lib/usePolledDevices";
import { useSessionInfo } from "../lib/useSessionInfo";
import { loadDismissed, pendingSetupWarnings, saveDismissed, visibleWarnings, warningKey } from "../lib/setupWarnings";

const POLL_INTERVAL_MS = 60_000;

/**
 * App-wide reminder that a device setting from src/deviceSetupChecks.ts is
 * not applied. The fix itself stays a click on the device card (spec D-1);
 * this only links there, and can be hidden by a viewer who does not want it.
 */
export function SetupWarningBar({ devices, admin }: { devices: readonly DeviceEntry[]; admin: boolean }) {
  const [dismissed, setDismissed] = useState(loadDismissed);
  const warnings = visibleWarnings(pendingSetupWarnings(devices), dismissed);
  if (warnings.length === 0) return null;

  const hide = () => {
    const next = new Set(dismissed);
    for (const warning of warnings) next.add(warningKey(warning));
    saveDismissed(next);
    setDismissed(next);
  };

  const single = warnings.length === 1 ? warnings[0] : undefined;
  const deviceCount = new Set(warnings.map((warning) => warning.deviceId)).size;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs sm:px-6"
      style={{ borderColor: "var(--warn-amber)", color: "var(--foreground)" }}
    >
      <span className="font-medium" style={{ color: "var(--warn-amber)" }}>
        {single
          ? `${single.deviceLabel}: ${single.title}`
          : `${warnings.length} device settings are not applied on ${deviceCount} ${deviceCount === 1 ? "device" : "devices"}`}
      </span>
      {single && <span className="ops-muted">{single.detail}</span>}
      {admin ? (
        <Link
          href={single ? `/devices#device-${encodeURIComponent(single.deviceId)}` : "/devices"}
          className="underline"
        >
          {single ? "Fix it" : "Fix them"}
        </Link>
      ) : (
        <span className="ops-muted">Ask an admin to fix this.</span>
      )}
      <button type="button" onClick={hide} className="ml-auto underline ops-muted">
        Hide
      </button>
    </div>
  );
}

/** Root-layout wrapper: polls the device list itself, hidden on /login. */
export function GlobalSetupWarningBar() {
  const pathname = usePathname();
  const sessionInfo = useSessionInfo();
  const { devices, loaded } = usePolledDevices({
    fetchDevices: () => fetchDevices(),
    intervalMs: POLL_INTERVAL_MS,
    isVisible: () => document.visibilityState === "visible",
  });
  if (pathname === "/login" || !loaded) return null;
  return <SetupWarningBar devices={devices} admin={sessionInfo?.user.isAdmin ?? false} />;
}
