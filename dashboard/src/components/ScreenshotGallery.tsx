"use client";
import { useState } from "react";
import type { StepWithArtifacts } from "../lib/api";
import { getActiveOrgId } from "../lib/activeOrg";
import { ArtifactImage } from "./ArtifactImage";

export function ScreenshotGallery({ step }: { step: StepWithArtifacts }) {
  const screenshots = step.artifacts.filter((artifact) => artifact.kind === "screenshot");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const finalPath = `${step.jobId}/${step.ordinal}/final.png`;
  const selected = screenshots.find((artifact) => artifact.id === selectedId)
    ?? screenshots.find((artifact) => artifact.relPath === finalPath)
    ?? screenshots.at(-1);
  if (!selected) return null;
  const orgId = getActiveOrgId();
  const href = `/api/artifacts/${selected.id}${orgId === undefined ? "" : `?orgId=${orgId}`}`;
  const filename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

  return (
    <section className="job-gallery" aria-label={`${step.name} screenshots`}>
      <h3>Screenshots <span className="job-secondary">· {screenshots.length}</span></h3>
      <a className="job-media-stage" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${filename(selected.relPath)} at full size (new tab)`}>
        <ArtifactImage key={selected.id} artifactId={selected.id} alt={`${step.name} screenshot`} className="job-screenshot" />
      </a>
      <div className="job-caption">{filename(selected.relPath)}{selected.relPath === finalPath && " · End of flow"}</div>
      {screenshots.length > 1 && (
        <div className="job-thumbnails" aria-label="Choose screenshot">
          {screenshots.map((artifact) => (
            <button type="button" key={artifact.id} aria-pressed={artifact.id === selected.id} onClick={() => setSelectedId(artifact.id)} className="job-thumbnail">
              <ArtifactImage artifactId={artifact.id} alt="" className="job-thumbnail-image" />
              <span>{artifact.relPath === finalPath ? "End of flow" : filename(artifact.relPath)}</span>
            </button>
          ))}
        </div>
      )}
      <a className="job-artifact-link" href={href} target="_blank" rel="noopener noreferrer">Open full-size screenshot ↗</a>
    </section>
  );
}
