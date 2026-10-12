"use client";
import { MaintenanceCard } from '../../components/MaintenanceCard';
import { fetchDevices, fetchSession } from "../../lib/api";
import {useEffect,useState} from 'react';
import {EditionCard} from '../../components/EditionCard';
import { usePolledDevices } from "../../lib/usePolledDevices";
import { useRequireSession } from "../../lib/useRequireSession";
import { DeviceCard } from "../../components/DeviceCard";
import { AddDeviceForm } from "../../components/AddDeviceForm";
import { Skeleton } from "../../components/Skeleton";
import { artifactLevel } from "../../lib/artifactThreshold";

const POLL_INTERVAL_MS = 10_000;

const LEVEL_COLOR: Record<ReturnType<typeof artifactLevel>, string> = {
  ok: "var(--muted)",
  amber: "var(--warn-amber)",
  red: "var(--warn-red)",
};

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(1)} MB`;
}

export default function DevicesPage() {
  const sessionState = useRequireSession();
  const [admin,setAdmin]=useState(false);
  useEffect(()=>{let active=true;void fetchSession().then(s=>{if(active)setAdmin(s.user.isAdmin);}).catch(()=>{});return()=>{active=false;};},[]);
  const { devices, runnerVersion, artifactBytes, loaded, refresh } = usePolledDevices({
    fetchDevices: () => fetchDevices(),
    intervalMs: POLL_INTERVAL_MS,
    isVisible: () => document.visibilityState === "visible",
  });

  if (sessionState !== "ok" || !loaded) {
    return (
      <main className="ops-page" role="status" aria-label="Loading">
        <div className="ops-title"><div><h1>Devices</h1><p className="ops-muted">Connection status, scheduling, and device actions in one place.</p></div></div>
        <div className="ops-stats">{[0,1,2].map(i => <Skeleton key={i} className="h-20 w-full" />)}</div>
        <div className="ops-device-grid"><Skeleton className="h-64 w-full" /><Skeleton className="h-64 w-full" /></div>
      </main>
    );
  }

  return <main className="ops-page">
    <MaintenanceCard readOnly />
    <div className="ops-title"><div><h1>Devices</h1><p className="ops-muted">Connection status, scheduling, and device actions in one place.</p></div><AddDeviceForm onAdded={refresh} /></div>
    <EditionCard admin={admin} devices={devices} onChanged={refresh} />
    <section className="ops-stats" aria-label="Device summary">
      <div><p className="ops-muted ops-small">Connected &amp; authorized</p><p className="ops-value">{devices.filter(device => device.state === "device").length} of {devices.length}</p></div>
      <div><p className="ops-muted ops-small">Enabled for jobs</p><p className="ops-value">{devices.filter(device => device.isActive).length} {devices.filter(device => device.isActive).length === 1 ? "device" : "devices"}</p></div>
      <div><p className="ops-muted ops-small">Needs authorization</p><p className="ops-value" style={{color:"var(--warn-amber)"}}>{devices.filter(device => device.state === "unauthorized").length} {devices.filter(device => device.state === "unauthorized").length === 1 ? "device" : "devices"}</p></div>
    </section>
    <div className="ops-device-grid">{devices.map(device => <DeviceCard key={device.id} device={device} onChanged={refresh} />)}</div>
    {!devices.length && <section className="ops-box ops-empty"><h2>Connect your first device</h2><p className="ops-muted">Connect an Android device with USB debugging enabled, then register it with the farm.</p></section>}
    <div className="ops-runner"><span>Runner <span className="ops-mono">{runnerVersion}</span></span>{artifactBytes > 0 && <span data-testid="artifact-bytes" style={{color:LEVEL_COLOR[artifactLevel(artifactBytes)]}}>Artifact storage · {formatBytes(artifactBytes)} across the farm</span>}</div>
  </main>;
}
