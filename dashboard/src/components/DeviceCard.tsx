"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ActionDialog, DialogActions } from "./ActionDialog";
import { KeyIcon, TrashIcon, EyeIcon, SlidersIcon } from "./icons";
import {
  enableDevice,
  disableDevice,
  removeDevice,
  rebootDevice,
  fixDeviceSetupCheck,
  fetchDeviceEvents,
  takeDeviceScreenshot,
  ApiError,
  type DeviceEntry,
  type DeviceEventEntry,
} from "../lib/api";

const STATE_LABEL: Record<string, string> = {
  device: "Online",
  unauthorized: "Unauthorized",
  offline: "Not connected",
};

const STATE_COLOR: Record<string, string> = {
  device: "var(--status-passed)",
  unauthorized: "var(--warn-amber)",
  offline: "var(--status-skipped)",
};

function StateDot({ state }: { state: string }) {
  const color = STATE_COLOR[state] ?? "var(--muted)";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

function EventLog({ events }: { events: DeviceEventEntry[] | undefined }) {
  if (events === undefined) return <p className="text-xs text-(--muted)">Loading log…</p>;
  if (events.length === 0) return <p className="text-xs text-(--muted)">No activity recorded yet.</p>;
  return (
    <ul className="mono max-h-40 overflow-auto text-xs text-(--muted)">
      {events.map((e) => (
        <li key={e.id} className="flex gap-2 border-b border-(--border) py-1 last:border-0">
          <span className="shrink-0 text-(--muted)">{new Date(e.createdAt).toLocaleTimeString()}</span>
          <span className="shrink-0 text-(--foreground)">{e.kind}</span>
          <span className="truncate">{e.detail}</span>
        </li>
      ))}
    </ul>
  );
}

type Confirmable = "reboot" | "enable" | "disable" | "remove";

/** What each confirmation actually says. A lookup rather than a chain of
 * ternaries, so adding an action cannot silently reuse another's wording. */
const CONFIRM_COPY: Record<Confirmable, { title: string; body: string }> = {
  remove: { title: "Remove device", body: "Remove this device from the farm. It can be added again later." },
  reboot: {
    title: "Reboot device",
    body: "The device will disconnect while restarting. This can interrupt a running job.",
  },
  disable: { title: "Disable device", body: "Stop scheduling new jobs on this device." },
  enable: {
    title: "Enable device",
    body: "Allow the runner to schedule jobs on this device when it is online.",
  },
};

const CONFIRM_ACTION: Record<Confirmable, (id: string) => Promise<unknown>> = {
  enable: enableDevice,
  disable: disableDevice,
  remove: removeDevice,
  reboot: rebootDevice,
};

// artifactBytes is deliberately NOT a prop: it is one farm-wide total for the
// host's artifact directory, not per-device usage. Rendering it on every card
// made the same number appear once per phone, which reads as attribution to
// that phone. It belongs to the page, not the device - see DevicesPage.
export function DeviceCard({ device, onChanged, admin = false }: { device: DeviceEntry; onChanged: () => void; admin?: boolean }) {
  const [events, setEvents] = useState<DeviceEventEntry[] | undefined>(undefined);
  const [screenshotUrl, setScreenshotUrl] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState<Confirmable | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchDeviceEvents(device.id, 10)
      .then((e) => {
        if (!cancelled) setEvents(e);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
    // Re-fetched by the parent's key={device.id} remount on device set changes;
    // deliberately not re-run on every device prop change (a poll tick) or the
    // log would refetch every 10s even with nothing new to show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id]);

  // The object URL an in-flight or previous capture created is only ever
  // referenced from this closure - revoke it here rather than leaking one
  // blob URL per screenshot taken over the page's lifetime.
  useEffect(() => {
    return () => {
      if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
    };
  }, [screenshotUrl]);

  const runOp = async (op: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await op();
      setConfirming(undefined);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the operation failed");
    } finally {
      setBusy(false);
    }
  };

  const doScreenshot = () =>
    runOp(async () => {
      const url = await takeDeviceScreenshot(device.id);
      setScreenshotUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    });

  return (
    // The id is what the app-wide SetupWarningBar links to.
    <div id={`device-${device.id}`} className="ops-box ops-pad ops-device-card rounded-lg">
      <div className="ops-device-top"><div className="ops-device-icon" aria-hidden="true"><svg width="22" height="26" viewBox="0 0 22 26" fill="none"><rect x="4" y="1" width="14" height="24" rx="3" stroke="currentColor" strokeWidth="1.5" /><path d="M9 21h4" stroke="currentColor" strokeWidth="1.5" /></svg></div><div className="ops-device-name"><h2>{device.label}</h2><p className="ops-muted ops-small">{device.model ?? "Unknown model"}</p></div><StateDot state={device.state} /></div>
      <dl className="ops-device-hardware"><div><dt>Scheduling</dt><dd>{device.isActive ? "Enabled for jobs" : "Disabled"}</dd></div><div><dt>Device ID</dt><dd className="ops-mono">{device.id}</dd></div><div><dt>Reset before job</dt><dd>{device.resetPolicy === "app-and-browser" ? "App and browser" : "App only"}</dd></div>{device.isolationCapable !== undefined && <div><dt>Work-profile isolation</dt><dd>{device.isolationCapable === null ? "Unknown" : device.isolationCapable ? "Supported" : "Not supported"}</dd></div>}</dl>
      {device.state === "unauthorized" && <p className="ops-muted ops-small mb-4">Accept the USB debugging prompt on the device to allow flows to run.</p>}
      {device.setupChecks?.filter((check) => check.ok === false).map((check) => (
        <div
          key={check.id}
          data-testid={`setup-check-${check.id}`}
          className="mb-4 rounded border p-3 text-xs"
          style={{ borderColor: "var(--warn-amber)" }}
        >
          <p className="font-medium" style={{ color: "var(--warn-amber)" }}>{check.title}</p>
          <p className="ops-muted mt-1">{check.detail}</p>
          <p className="ops-muted mt-1">See &ldquo;Required device settings&rdquo; in the operating guide.</p>
          {/* The fix route sits behind the edition policy: on a device the
              edition does not allow it can only answer 409, so no button -
              the card's "Not available" hint already says why. */}
          {admin && device.isAvailable !== false ? (
            <button
              className="ui-button mt-2"
              aria-label={`Fix: ${check.title}`}
              disabled={busy}
              onClick={() => void runOp(() => fixDeviceSetupCheck(device.id, check.id))}
            >
              Fix
            </button>
          ) : (
            <p className="ops-muted mt-2">Ask an admin to fix this.</p>
          )}
        </div>
      ))}
      {device.isAvailable===false&&<p className="ops-muted ops-small mb-4">Not available in the current edition. Select this as the Community device or activate Pro.</p>}
      {error && !confirming && <p role="alert" className="mb-3 text-xs text-(--status-failed)">{error}</p>}

      {screenshotUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={screenshotUrl}
          alt={`${device.label} screenshot`}
          className="mb-3 max-h-72 rounded border border-(--border)"
        />
      )}


      <div className="ops-device-actions">
        {device.state === "device" && device.isAvailable!==false && <button className="ops-action" disabled={busy} onClick={doScreenshot}><EyeIcon />{busy ? "Working…" : "Take screenshot"}</button>}
        {device.state === "device" && device.isAvailable!==false && (
          <Link className="ops-action" href={`/devices/control?device=${encodeURIComponent(device.id)}`}>
            <EyeIcon />Open screen
          </Link>
        )}
        <Link className="ops-action" href={`/devices/configure?device=${encodeURIComponent(device.id)}`}>
          <SlidersIcon />Configure device
        </Link>
        <details className="ops-device-manage"><summary className="ops-link">Manage device →</summary><div className="flex flex-wrap gap-3 py-3">
          <button className="ui-button" disabled={busy} onClick={() => { setError(undefined); setConfirming(device.isActive ? "disable" : "enable"); }}><KeyIcon />{device.isActive ? "Disable" : "Enable"}</button>
          {!device.isActive && <button className="ui-button" disabled={busy} onClick={() => { setError(undefined); setConfirming("remove"); }}><TrashIcon />Remove</button>}
          {device.state === "device" && <button className="ui-button" disabled={busy} onClick={() => { setError(undefined); setConfirming("reboot"); }}>↻ Reboot</button>}
        </div></details>
      </div>
      <details><summary>Recent activity</summary><EventLog events={events} /></details>
      <ActionDialog open={!!confirming} onClose={() => setConfirming(undefined)} title={confirming ? CONFIRM_COPY[confirming].title : "Device action"} target={device.label} busy={busy} danger={confirming !== "enable"}>
        <p className="ui-muted">{confirming ? CONFIRM_COPY[confirming].body : ""}</p>
        {error && <p role="alert" className="ui-error">{error}</p>}
        <DialogActions onClose={() => setConfirming(undefined)} busy={busy} danger={confirming !== "enable"} label={confirming ? CONFIRM_COPY[confirming].title : "Confirm"} onConfirm={() => { if (confirming) void runOp(() => CONFIRM_ACTION[confirming](device.id)); }} />
      </ActionDialog>
    </div>
  );
}
