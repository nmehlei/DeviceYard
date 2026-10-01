"use client";
import { useState } from "react";
import Link from "next/link";
import type { JobListEntry } from "../lib/api";
import { listJobOutcome } from "../lib/listJobOutcome";
import { completedDuration, formatRunDuration } from "../lib/runDuration";
import { formatRelativeTime } from "../lib/relativeTime";
import { RunOutcome } from "./RunOutcome";

export function RecentJobsChart({ jobs, deviceName = job => job.deviceId ?? "Awaiting assignment" }: { jobs: JobListEntry[]; deviceName?: (job: JobListEntry) => string }) {
  const [selectedId, setSelectedId] = useState<string>();
  if (!jobs.length) return <p className="ops-muted">No jobs yet — trigger a run to see it here.</p>;
  const ordered = [...jobs].sort((a, b) => a.createdAt - b.createdAt);
  const maximum = Math.max(...jobs.map(job => (completedDuration(job) ?? 0) / 1000), 1);
  const tick = maximum <= 60 ? Math.max(1, Math.ceil(maximum / 4 / 5) * 5) : Math.ceil(maximum / 4 / 60) * 60;
  const ceiling = tick * 4;
  const selected = jobs.find(job => job.id === selectedId) ?? ordered[ordered.length - 1];
  const unknown = jobs.some(job => listJobOutcome(job) === "unknown");
  return <section className="run-chart" aria-label="Recent job duration and outcome">
    <div className="chart-heading"><div><h2>Run history</h2><p className="ops-muted ops-small">Duration and outcome · Latest {jobs.length} jobs</p></div>
      <div className="chart-legend" aria-label="Outcome legend">{["passed", "failed", "running", "queued", ...(unknown ? ["unknown"] : [])].map(outcome => <span key={outcome}><i className="chart-swatch" data-outcome={outcome} aria-hidden="true" />{outcome === "unknown" ? "No result" : outcome[0].toUpperCase() + outcome.slice(1)}</span>)}</div>
    </div>
    <div className="chart-area">
      <div className="chart-y" aria-hidden="true">{[4, 3, 2, 1, 0].map(value => <span key={value}>{value ? formatRunDuration(value * tick * 1000) : "0"}</span>)}</div>
      <div className="chart-bars recent-run-chart" aria-label="Outcome and duration of recent jobs" style={{ gridTemplateColumns: `repeat(${jobs.length}, minmax(0, 1fr))` }}>
        {ordered.map(job => {
          const duration = completedDuration(job);
          return <Link key={job.id} href={`/jobs/${job.id}`} className="chart-column" onMouseEnter={() => setSelectedId(job.id)} onFocus={() => setSelectedId(job.id)} aria-label={`${job.id} · ${listJobOutcome(job)} · ${duration === null ? "Duration unavailable" : formatRunDuration(duration)}`}>
            <span className="chart-value">{formatRunDuration(duration)}</span>
            <span className="chart-bar recent-run-bar" data-outcome={listJobOutcome(job)} style={{ height: duration === null ? "5px" : `${Math.max(2, duration / 1000 / ceiling * 100)}%` }} />
          </Link>;
        })}
      </div>
      <div className="chart-x"><span>{formatRelativeTime(ordered[0].createdAt)}</span><span>Most recent →</span></div>
    </div>
    <div className="chart-readout" aria-live="polite"><span className="ops-mono">{selected.id}</span><span><RunOutcome job={selected} /><span className="ops-muted"> · {formatRunDuration(completedDuration(selected))} · {deviceName(selected)}</span></span><span className="chart-hint">Select a run to inspect</span></div>
  </section>;
}
