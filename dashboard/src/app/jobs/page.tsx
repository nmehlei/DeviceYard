"use client";
import { MaintenanceCard } from '../../components/MaintenanceCard';
import { useEffect, useState } from "react";
import { useJobEvents } from "../../lib/useJobEvents";
import { useDeviceLabels, jobDeviceDisplayName } from "../../lib/useDeviceLabels";
import { useRequireSession } from "../../lib/useRequireSession";
import { jobOutcome, durationLabel } from "../../lib/jobPresentation";
import { StepTimeline } from "../../components/StepTimeline";
import { Skeleton } from "../../components/Skeleton";
import { jobWaitingReason } from '../../lib/jobWaitingReason';

function JobPageSkeleton() {
  return (
    <main className="job-page" role="status" aria-label="Loading">
      <Skeleton className="mb-6 h-32 w-full rounded-xl" />
      <Skeleton className="mb-8 h-36 w-full rounded-xl" />
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </main>
  );
}

function jobIdFromPath(pathname: string): string {
  // Matches server.ts's GET /jobs/:id fallback: everything after "/jobs/" is
  // the id, since this same static file is served for any such path.
  return decodeURIComponent(pathname.replace(/^\/jobs\//, ""));
}

export default function JobPage() {
  const [jobId, setJobId] = useState<string | undefined>(undefined);

  useEffect(() => {
    setJobId(jobIdFromPath(window.location.pathname));
  }, []);

  const sessionState = useRequireSession();
  const { detail, status } = useJobEvents(jobId ?? "");
  // Before the early returns below: hooks must run on every render.
  const deviceLabels = useDeviceLabels();

  if (sessionState !== "ok" || jobId === undefined || status === "connecting") {
    return <JobPageSkeleton />;
  }

  if (status === "not-found") {
    return <main className="p-8 text-(--muted)">Job not found.</main>;
  }

  if (!detail) {
    return <JobPageSkeleton />;
  }

  const outcome = jobOutcome(detail);
  const countSummary = Object.entries(outcome.counts).filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`).join(" · ");
  const timestamp = (value: number | null, fallback: string) => value === null ? fallback : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(value);
  const terminal = detail.job.status === "done" || detail.job.status === "failed";

  return (
    <main className="job-page">
      <MaintenanceCard readOnly />
      <a href="/history" className="job-back">← Job history</a>
      <section className="job-outcome" style={{ "--job-outcome-color": `var(--status-${outcome.tone})` } as React.CSSProperties} aria-label="Job result">
        <span className="job-outcome-icon" aria-hidden="true">{outcome.symbol}</span>
        <div aria-live="polite">
          <div className="job-eyebrow">Job result</div>
          <h1>{outcome.title}</h1>
          <p className="job-secondary">{countSummary || (terminal ? "No flow results" : "Waiting for flow results")}</p>
          {detail.job.error && <p className="job-error">{detail.job.error}</p>}
          {detail.job.status === 'queued' && jobWaitingReason(detail.job.waitingReason) &&
            <p role="status">{jobWaitingReason(detail.job.waitingReason)}</p>}
        </div>
      </section>
        {status === "reconnecting" && (
          <p className="job-connection" role="status">Reconnecting… Showing the last known state.</p>
        )}
      <dl className="job-metadata" aria-label="Job metadata">
        <div><dt>Device</dt><dd data-testid="job-device">
          {jobDeviceDisplayName(detail.job.deviceId, detail.job.status, deviceLabels)}
        </dd></div>
        <div><dt>Job ID</dt><dd className="mono">{detail.job.id}</dd></div>
        {!!detail.job.requiredDeviceTags?.length && <div><dt>Required device tags</dt><dd>{detail.job.requiredDeviceTags.join(', ')}</dd></div>}
        <div><dt>Execution time</dt><dd>{detail.job.startedAt === null ? "Not started" : detail.job.finishedAt === null ? (terminal ? "Not recorded" : "In progress") : durationLabel(detail.job.startedAt, detail.job.finishedAt)}</dd></div>
        <div><dt>Created</dt><dd>{timestamp(detail.job.createdAt, "Not recorded")}</dd></div>
        <div><dt>Started</dt><dd>{timestamp(detail.job.startedAt, "Not started")}</dd></div>
        <div><dt>Finished</dt><dd>{timestamp(detail.job.finishedAt, terminal ? "Not recorded" : "Not finished")}</dd></div>
      </dl>
      <StepTimeline steps={detail.steps} />
    </main>
  );
}
