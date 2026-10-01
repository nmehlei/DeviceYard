"use client";
import Link from "next/link";
import { useState } from "react";
import { listJobOutcome } from "../../lib/listJobOutcome";
import { fetchJobs } from "../../lib/api";
import { usePolledJobs } from "../../lib/usePolledJobs";
import { useRequireSession } from "../../lib/useRequireSession";
import { useDeviceLabels, jobDeviceDisplayName } from "../../lib/useDeviceLabels";
import { formatRelativeTime } from "../../lib/relativeTime";
import { RunOutcome } from "../../components/RunOutcome";
import { completedDuration, formatRunDuration } from "../../lib/runDuration";
import { Skeleton } from "../../components/Skeleton";

const POLL_INTERVAL_MS = 12_000;

export default function JobHistoryPage() {
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState("all");
  const sessionState = useRequireSession();
  const { jobs, loaded } = usePolledJobs({
    fetchJobs: () => fetchJobs(50),
    intervalMs: POLL_INTERVAL_MS,
    isVisible: () => document.visibilityState === "visible",
  });
  // Before the early returns below: hooks must run on every render.
  const deviceLabels = useDeviceLabels();
  const filteredJobs = jobs.filter(job => (outcome === "all" || (outcome === "active" && ["queued", "running"].includes(job.status)) || listJobOutcome(job) === outcome) && `${job.id} ${jobDeviceDisplayName(job.deviceId, job.status, deviceLabels)}`.toLowerCase().includes(query.toLowerCase()));

  if (sessionState !== "ok" || !loaded) {
    return (
      <main className="ops-page" role="status" aria-label="Loading">
        <div className="ops-title"><div><h1>Jobs</h1><p className="ops-muted">Find a result. Follow a running job. Inspect what failed.</p></div><Link href="/cli" className="ops-action">Run from CLI</Link></div>
        <div className="flex flex-col gap-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </main>
    );
  }

  if (jobs.length === 0) {
    return <main className="ops-page"><div className="ops-title"><div><h1>Jobs</h1><p className="ops-muted">Find a result. Follow a running job. Inspect what failed.</p></div><Link href="/cli" className="ops-action">Run from CLI</Link></div><p className="ops-muted">No jobs yet — trigger a run to see it here.</p></main>;
  }

  return (
    <main className="ops-page">
      <div className="ops-title"><div><h1>Jobs</h1><p className="ops-muted">Find a result. Follow a running job. Inspect what failed.</p></div><Link href="/cli" className="ops-action">Run from CLI</Link></div>
      <div className="ops-toolbar"><div className="ops-filters" aria-label="Filter by outcome">{[["all", "All jobs"], ["failed", "Failed"], ["active", "Active"], ["passed", "Passed"], ["unknown", "No result"]].filter(([value]) => value !== "unknown" || jobs.some(job => listJobOutcome(job) === "unknown")).map(([value, label]) => <button key={value} aria-pressed={outcome === value} onClick={() => setOutcome(value)}>{label}</button>)}</div><label className="ops-search"><span aria-hidden="true">⌕</span><input aria-label="Search jobs" placeholder="Search job or device" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <div className="ops-box ops-table"><table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-(--border) text-left text-(--muted)">
            <th>Job / device</th>
            <th>Outcome</th>
            <th className="ops-hide-mobile">Flows</th>
            <th className="ops-hide-mobile">Duration</th>
            <th className="ops-hide-mobile">App</th>
            <th className="py-2 font-normal">Created</th>
          </tr>
        </thead>
        <tbody>
          {filteredJobs.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-(--muted)">No jobs match these filters.</td></tr>}
          {filteredJobs.map((job) => (
            <tr key={job.id} className="border-b border-(--border)">
              <td className="py-3">
                <Link href={`/jobs/${job.id}`} className="mono text-(--foreground) hover:underline">
                  {job.id}
                </Link>
                <p className="ops-sub" data-testid="job-device">{jobDeviceDisplayName(job.deviceId, job.status, deviceLabels)}</p>
                <p className="ops-mobile-detail ops-sub">{job.passed}/{job.flowCount} passed · {job.failed} failed · {formatRunDuration(completedDuration(job))}</p>
              </td>
              <td className="py-3" title={job.error ?? undefined}>
                <RunOutcome job={job} />
              </td>
              <td className="ops-hide-mobile">
                <div className="ops-flow-summary"><span>{job.passed}/{job.flowCount} passed</span>{job.failed > 0 && <span> · {job.failed} failed</span>}<div className="ops-flow-bar" aria-label={`${job.passed} passed, ${job.failed} failed, ${job.running} running of ${job.flowCount} flows`}>{[["passed", job.passed], ["failed", job.failed], ["running", job.running]].map(([status, count]) => <span key={status} style={{width:`${Number(count) / Math.max(job.flowCount, 1) * 100}%`,background:`var(--status-${status})`}} />)}</div></div>
              </td>
              <td className="ops-hide-mobile ops-muted">
                {job.status === "running" ? "In progress" : formatRunDuration(completedDuration(job))}
              </td>
              <td className="ops-hide-mobile">
                <span className="mono">{job.appId ?? "—"}</span>
                {job.appVersion && <p className="ops-sub">{job.appVersion}</p>}
              </td>
              <td className="py-3 text-(--muted)" title={new Date(job.createdAt).toLocaleString()}>
                {formatRelativeTime(job.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table><div className="ops-table-footer" aria-live="polite">{filteredJobs.length} of {jobs.length} jobs · Search and filters apply to the latest 50 jobs</div></div>
    </main>
  );
}
