"use client";
import { Suspense, useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRequireSession } from "../../../lib/useRequireSession";
import { DeviceScreen, type ScreenState } from "../../../components/DeviceScreen";
import { ControlSidebar } from "../../../components/ControlSidebar";

/**
 * The device's own screen page (spec D-11). A query parameter rather than a
 * route segment, so the static export needs no generateStaticParams for device
 * ids that do not exist at build time. The phone is ~1:2.14, so height is the
 * scarce axis: the screen takes the viewport height and controls sit beside it.
 */
function ControlScreen() {
  const deviceId = useSearchParams().get("device");
  const sessionState = useRequireSession();

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
      <ControlLayout deviceId={deviceId} />
    </main>
  );
}

function ControlLayout({ deviceId }: { deviceId: string }) {
  const [screen, setScreen] = useState<ScreenState>({ connection: "connecting", webCodecs: true });
  const sendRef = useRef<(message: object) => void>(() => {});
  const register = useCallback((send: (message: object) => void) => { sendRef.current = send; }, []);
  const send = useCallback((message: object) => sendRef.current(message), []);

  return (
    <div className="flex gap-4" style={{ height: "calc(100vh - 11rem)" }}>
      <div className="flex-1 min-w-0">
        <DeviceScreen deviceId={deviceId} onState={setScreen} register={register} />
      </div>
      <ControlSidebar state={screen} send={send} />
    </div>
  );
}

export default function ControlPage() {
  return (
    <Suspense fallback={<main className="ops-page" role="status" aria-label="Loading" />}>
      <ControlScreen />
    </Suspense>
  );
}
