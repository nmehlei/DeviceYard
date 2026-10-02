"use client";
import { useState } from "react";
import type { StepWithArtifacts } from "../lib/api";
import { StatusBadge } from "./StatusBadge";
import { ScreenshotGallery } from "./ScreenshotGallery";
import { durationLabel } from "../lib/jobPresentation";
import { ArtifactVideo } from "./ArtifactVideo";
import { LogViewer } from "./LogViewer";
import { getActiveOrgId } from "../lib/activeOrg";

// Cycle 1's data model deliberately labels device/install/extract failures
// as kind='setup' rows rather than fake flow results named <device> etc.
// (design doc, "flow_runs" section) - the UI must honor that, not flatten
// setup rows back into looking like a flow.
const SETUP_LABELS: Record<string, string> = {
  device: "Device preparation",
  install: "App install",
  extract: "Flow archive extraction",
};

// <a href> can't set a custom X-Org-Id header, so the active org is
// appended as ?orgId= instead - see the same fallback added to
// ArtifactImage.tsx/useJobEvents.ts.
function hierarchyHref(artifactId: number): string {
  const activeOrgId = getActiveOrgId();
  return activeOrgId === undefined ? `/api/artifacts/${artifactId}` : `/api/artifacts/${artifactId}?orgId=${activeOrgId}`;
}

function stepTitle(step: StepWithArtifacts): string {
  if (step.kind !== "setup") return step.name;
  const label = SETUP_LABELS[step.name] ?? step.name;
  return step.status === "failed" ? `${label} failed` : label;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      className={`shrink-0 text-(--muted) transition-transform duration-150 ${open ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StepCard({ step, index }: { step: StepWithArtifacts; index: number }) {
  // Initial value only - set once from the status this step had when the
  // card first mounted, then left entirely to the visitor's own clicks. A
  // step whose status later changes (e.g. a live job's "running" step
  // finishing) must never yank open/shut a card the visitor already toggled
  // by hand.
  const [open, setOpen] = useState(() => step.status === "failed" || step.status === "running");

  // Keep artifacts attached to their flow; the gallery exposes every capture.
  const hierarchy = step.artifacts.find((a) => a.kind === "hierarchy");
  const videos = step.artifacts.filter((a) => a.kind === "recording");
  const hasScreenshots = step.artifacts.some((a) => a.kind === "screenshot");

  return (
    <li className={`job-step ${step.kind === "setup" ? "job-setup" : ""}`}>
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="job-step-summary">
            <ChevronIcon open={open} />
            {step.kind === "flow" && <span className="job-step-number">{String(index + 1).padStart(2, "0")}</span>}
            <span className="job-step-name">{stepTitle(step)}<small>{step.kind === "flow" ? "Flow" : "Preparation"}</small></span>
          <StatusBadge status={step.status} />
          <span className="job-step-duration">{step.status === "running" ? "In progress" : durationLabel(step.startedAt, step.finishedAt)}</span>
        </summary>

        <div className="job-step-details">
          {step.warnings.length > 0 && (
            <ul aria-label="Warnings" className="job-warnings">
              {step.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          {(hasScreenshots || videos.length > 0) && <div className="job-media-grid">
            {hasScreenshots && <ScreenshotGallery step={step} />}
            {videos.map((video, i) => <section key={video.id}>
              <h3>Screen recording{videos.length > 1 ? ` · ${i + 1}` : ""}</h3>
              <div className="job-media-stage"><ArtifactVideo artifactId={video.id} label={`${step.name} recording${videos.length > 1 ? ` ${i + 1}` : ""}`} className="job-video" /></div>
            </section>)}
          </div>}

          {(step.stdoutPreview !== null || step.stderrPreview !== null) && (
            <section><h3>Execution log</h3><LogViewer stepId={step.id} preview={step.stdoutPreview} stderrPreview={step.stderrPreview} /></section>
          )}

          {hierarchy && (
            <a href={hierarchyHref(hierarchy.id)} className="job-artifact-link">
              View hierarchy dump
            </a>
          )}
        </div>
      </details>
    </li>
  );
}

export function StepTimeline({ steps }: { steps: StepWithArtifacts[] }) {
  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  const preparation = ordered.filter((step) => step.kind === "setup");
  const flows = ordered.filter((step) => step.kind === "flow");
  return (
    <>
      {preparation.length > 0 && <section aria-label="Preparation">
        <div className="job-section-heading"><h2>Preparation</h2><span>Before flow execution</span></div>
        <ol className="job-steps">{preparation.map((step, index) => <StepCard key={step.id} step={step} index={index} />)}</ol>
      </section>}
      <section aria-label="Flows">
        <div className="job-section-heading"><h2>Flows <span> / {flows.length}</span></h2><span>Execution order</span></div>
        {flows.length === 0 ? <p className="job-secondary">No flows to display.</p> : <ol className="job-steps">{flows.map((step, index) => <StepCard key={step.id} step={step} index={index} />)}</ol>}
      </section>
    </>
  );
}
