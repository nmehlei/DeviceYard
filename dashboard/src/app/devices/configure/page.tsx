"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { EditionDeviceSettings } from '../../../components/EditionDeviceSettings';
import { useRequireSession } from "../../../lib/useRequireSession";
import { useSessionInfo } from "../../../lib/useSessionInfo";
import { ActionDialog, DialogActions } from "../../../components/ActionDialog";
import {
  ApiError,
  fetchDevices,
  renameDevice,
  setDeviceResetPolicy,
  type DeviceEntry,
  type ResetPolicy,
} from "../../../lib/api";

/** Each option carries its consequence. This is the whole reason the policy
 * moved off a card button: three words could not say what it does. */
const POLICY_OPTIONS: ReadonlyArray<{ value: ResetPolicy; title: string; detail: string }> = [
  {
    value: "app-only",
    title: "App only",
    detail: "Clears the app under test before each job. Nothing else on the device is touched.",
  },
  {
    value: "app-and-browser",
    title: "App and browser",
    detail:
      "Also clears the default browser before each job: history, cookies, open tabs and any " +
      "saved passwords not covered by sync. Use this on a dedicated test device.",
  },
];

/**
 * Device settings (label, reset policy), as a subscreen rather than a card
 * button. A query parameter rather than a route segment, matching
 * /devices/control, so the static export needs no generateStaticParams for
 * device ids that do not exist at build time.
 */
function ConfigureScreen() {
  const deviceId = useSearchParams().get("device");
  const sessionState = useRequireSession();
  const isAdmin = useSessionInfo()?.user.isAdmin ?? false;

  if (sessionState !== "ok") {
    return <main className="ops-page" role="status" aria-label="Loading" />;
  }
  if (!deviceId) {
    return (
      <main className="ops-page">
        <p role="alert">No device selected.</p>
        <Link className="ops-link" href="/devices">← Devices</Link>
      </main>
    );
  }

  return (
    <main className="ops-page">
      <nav className="ops-small mb-3">
        <Link className="ops-link" href="/devices">← Devices</Link>
        <span className="ops-muted"> / </span>
        <span className="ops-mono">{deviceId}</span>
      </nav>
      <ConfigureForm deviceId={deviceId} isAdmin={isAdmin} />
    </main>
  );
}

function ConfigureForm({ deviceId, isAdmin }: { deviceId: string; isAdmin: boolean }) {
  const [device, setDevice] = useState<DeviceEntry | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const [label, setLabel] = useState("");
  const [policy, setPolicy] = useState<ResetPolicy>("app-only");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchDevices()
      .then(({ devices }) => {
        if (cancelled) return;
        const found = devices.find((d) => d.id === deviceId);
        if (!found) {
          setMissing(true);
          return;
        }
        setDevice(found);
        setLabel(found.label);
        setPolicy(found.resetPolicy);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "failed to load the device");
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  if (missing) {
    return <p role="alert">No device with id {deviceId}.</p>;
  }
  if (!device) {
    return <p role="status">Loading…</p>;
  }

  const trimmedLabel = label.trim();
  const labelChanged = trimmedLabel !== device.label;
  const policyChanged = policy !== device.resetPolicy;
  // Escalating deletes data on the next job, so it is confirmed at save time.
  // A radio button is easy to nudge; a destructive change must not become
  // saveable by drift.
  const escalating = policyChanged && policy === "app-and-browser";

  const persist = async () => {
    setBusy(true);
    setError(undefined);
    try {
      let latest = device;
      // Only what changed is sent, and the policy keeps its own admin-only,
      // audited endpoint rather than being folded into the rename.
      if (labelChanged) latest = await renameDevice(device.id, trimmedLabel);
      if (policyChanged) latest = await setDeviceResetPolicy(device.id, policy);
      setDevice(latest);
      setLabel(latest.label);
      setPolicy(latest.resetPolicy);
      setConfirming(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to save");
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => {
    setSaved(false);
    if (escalating) {
      setConfirming(true);
      return;
    }
    void persist();
  };

  return (
    <div className="ops-box ops-pad rounded-lg">
      <h1 className="mb-4">Configure device</h1>

      <label className="mb-1 block ops-small" htmlFor="device-label">Name</label>
      <input
        id="device-label"
        className="ui-input mb-4 w-full"
        value={label}
        maxLength={100}
        disabled={busy}
        onChange={(e) => {
          setLabel(e.target.value);
          setSaved(false);
        }}
      />

      <dl className="ops-device-hardware mb-4">
        <div><dt>Device ID</dt><dd className="ops-mono">{device.id}</dd></div>
        <div><dt>Model</dt><dd>{device.model ?? "Unknown model"}</dd></div>
        <div><dt>State</dt><dd>{device.state}</dd></div>
      </dl>

      <EditionDeviceSettings key={device.id} deviceId={device.id} isAdmin={isAdmin} tags={device.tags ?? []} />

      <fieldset className="mb-4" disabled={!isAdmin || busy}>
        <legend className="ops-small mb-1">Reset before each job</legend>
        {!isAdmin && (
          <p className="ops-muted ops-small mb-2">An admin must change the reset policy.</p>
        )}
        {POLICY_OPTIONS.map((option) => (
          <label key={option.value} className="mb-2 flex gap-2">
            <input
              type="radio"
              name="reset-policy"
              value={option.value}
              checked={policy === option.value}
              onChange={() => {
                setPolicy(option.value);
                setSaved(false);
              }}
            />
            <span>
              <span className="block">{option.title}</span>
              <span className="ops-muted ops-small block">{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {error && <p role="alert" className="ui-error mb-2">{error}</p>}
      {saved && <p role="status" className="ops-small mb-2">Saved.</p>}

      <div className="flex gap-3">
        <Link className="ui-button" href="/devices">Cancel</Link>
        <button
          className="ui-button ui-primary"
          disabled={busy || !trimmedLabel || (!labelChanged && !policyChanged)}
          onClick={onSave}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>

      <ActionDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Also reset browser"
        target={device.label}
        busy={busy}
        danger
      >
        <p className="ui-muted">
          Before every job, this device will clear its default browser as well as the app under
          test. That deletes the browser&apos;s history, cookies, open tabs and any saved passwords
          not covered by sync — permanently, starting with the next job.
        </p>
        {error && <p role="alert" className="ui-error">{error}</p>}
        <DialogActions
          onClose={() => setConfirming(false)}
          busy={busy}
          danger
          label="Save"
          onConfirm={() => void persist()}
        />
      </ActionDialog>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<main className="ops-page" role="status" aria-label="Loading" />}>
      <ConfigureScreen />
    </Suspense>
  );
}
