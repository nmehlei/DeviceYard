"use client";
import Link from "next/link";
import { listJobOutcome } from "../lib/listJobOutcome";
import { fetchJobs, fetchDevices } from "../lib/api";
import { usePolledDevices } from "../lib/usePolledDevices";
import { usePolledJobs } from "../lib/usePolledJobs";
import { useRequireSession } from "../lib/useRequireSession";
import { RecentJobsChart } from "../components/RecentJobsChart";
import { RunOutcome } from "../components/RunOutcome";
import { Skeleton } from "../components/Skeleton";
import { formatRelativeTime } from "../lib/relativeTime";
import { jobDeviceDisplayName, useDeviceLabels } from "../lib/useDeviceLabels";

const POLL_INTERVAL_MS = 12_000;
export default function LandingPage() {
  const sessionState = useRequireSession();
  const { jobs, loaded: jobsLoaded } = usePolledJobs({ fetchJobs: () => fetchJobs(20), intervalMs: POLL_INTERVAL_MS, isVisible: () => document.visibilityState === "visible" });
  const loaded = sessionState === "ok" && jobsLoaded;
  const deviceLabels = useDeviceLabels();
  const { devices, loaded: devicesLoaded } = usePolledDevices({ fetchDevices: () => fetchDevices(), intervalMs: POLL_INTERVAL_MS, isVisible: () => document.visibilityState === "visible" });
  const deviceName = (job: (typeof jobs)[number]) => jobDeviceDisplayName(job.deviceId, job.status, deviceLabels);
  const count = (outcome: ReturnType<typeof listJobOutcome>) => jobs.filter(job => listJobOutcome(job) === outcome).length;
  const runCount = (number: number) => `${number} ${number === 1 ? "run" : "runs"}`;
  const unauthorized = devices.filter(device => device.state === "unauthorized");
  return <main className="ops-page ops-overview">
    <div className="ops-title"><div><h1>Overview</h1><p className="ops-muted">Your latest runs and the devices behind them.</p></div><Link href="/cli" className="ops-action">Run from CLI</Link></div>
    {!loaded ? <div role="status" aria-label="Loading dashboard"><div className="ops-stats">{[0,1,2].map(i => <Skeleton key={i} className="h-24 w-full" />)}</div><Skeleton className="mb-8 h-80 w-full" /></div> : !jobs.length ? <section className="ops-box ops-empty"><h2>Your first run will show up here</h2><p className="ops-muted">Connect a device, then submit a Maestro flow from the CLI or MCP server.</p><div className="flex justify-center gap-3"><Link href="/devices" className="ops-action">Manage devices</Link><Link href="/cli" className="ops-action">Set up the CLI</Link></div></section> : <>
      <section className="ops-stats" aria-label={`Status of latest ${jobs.length} jobs`}>
        <div><p className="ops-muted ops-small">Needs attention</p><p className="ops-value ops-failed">{runCount(count("failed"))}</p><p className="ops-muted ops-small">Failed in the latest {jobs.length} jobs</p></div>
        <div><p className="ops-muted ops-small">In progress</p><p className="ops-value">{runCount(count("running"))}</p><p className="ops-muted ops-small">{count("queued") ? `${count("queued")} more waiting for a device` : "No jobs waiting for a device"}</p></div>
        <div><p className="ops-muted ops-small">Passed</p><p className="ops-value">{runCount(count("passed"))}</p><p className="ops-muted ops-small">All flows passed in each run{count("unknown") > 0 && ` · ${count("unknown")} without a result`}</p></div>
      </section>
      <RecentJobsChart jobs={jobs} deviceName={deviceName} />
    </>}
    <div className="ops-columns">
      <section><div className="ops-section-head"><h2>Latest runs</h2><Link href="/history" className="ops-link">View all jobs →</Link></div>
        <div className="ops-box">{!loaded ? <Skeleton className="h-40 w-full" /> : !jobs.length ? <p className="ops-pad ops-muted">No runs yet.</p> : jobs.slice(0, 4).map(job => <Link href={`/jobs/${job.id}`} key={job.id} className="ops-job-row">
          <div><p className="ops-mono">{job.id}</p><p className="ops-sub">{deviceName(job)} · {job.passed}/{job.flowCount} flows passed</p></div>
          <div className="ops-job-result"><RunOutcome job={job} /><p className="ops-sub">{formatRelativeTime(job.createdAt)}</p></div>
        </Link>)}</div>
      </section>
      <aside aria-label="Device availability"><div className="ops-section-head"><h2>Device connections</h2><Link href="/devices" className="ops-link">Manage →</Link></div>
        {unauthorized.length > 0 && <div className="ops-alert"><h3>Authorization needed</h3><p className="ops-small ops-muted">{unauthorized.map(device => device.label).join(", ")} {unauthorized.length === 1 ? "is" : "are"} connected but cannot run flows. Accept the USB debugging prompt on the device.</p></div>}
        <div className="ops-box ops-pad">{!devicesLoaded ? <p className="ops-muted">Loading devices…</p> : !devices.length ? <p className="ops-muted">No devices registered yet.</p> : devices.map(device => <div className="ops-device-line" key={device.id}><span>{device.label}</span><span className="ops-device-status" data-state={device.state}>{device.state === "device" ? "● Online" : device.state === "unauthorized" ? "! Unauthorized" : "○ Offline"}</span></div>)}</div>
      </aside>
    </div>
  </main>;
}
