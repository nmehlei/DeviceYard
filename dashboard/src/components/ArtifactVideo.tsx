"use client";
import { useState } from "react";
import { getActiveOrgId } from "../lib/activeOrg";

// Same same-origin-cookie reasoning and same "always a labeled placeholder,
// never a broken element" rule as ArtifactImage.tsx - and the same ?orgId=
// fallback, since <video src> can't set a custom X-Org-Id header either.
export function ArtifactVideo({
  artifactId,
  label,
  className,
}: {
  artifactId: number;
  label: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`flex items-center justify-center rounded border border-(--border) bg-(--surface) p-4 text-xs text-(--muted) ${className ?? ""}`}
      >
        Recording unavailable
      </div>
    );
  }

  const activeOrgId = getActiveOrgId();
  const src =
    activeOrgId === undefined ? `/api/artifacts/${artifactId}` : `/api/artifacts/${artifactId}?orgId=${activeOrgId}`;

  return (
    <video
      controls
      preload="none"
      aria-label={label}
      src={src}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
