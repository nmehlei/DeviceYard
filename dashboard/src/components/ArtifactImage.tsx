"use client";
import { useState } from "react";
import { getActiveOrgId } from "../lib/activeOrg";

// Same-origin request: the session cookie is sent automatically by the
// browser on a plain <img> just as it is on fetch/XHR for same-origin URLs -
// no credentials wiring needed here, unlike lib/api.ts's cross-context fetch
// calls where "same-origin" is an explicit fetch() option, not a default.
//
// Per the design doc's error-handling section, a missing/failed artifact
// must render as an inline placeholder in its own slot, never a broken-image
// icon or a failure that takes down the rest of the step card - mirrors
// cycle 1's own rule that artifact collection failures are warnings, never
// fatal.
export function ArtifactImage({ artifactId, alt, className }: { artifactId: number; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className={`flex items-center justify-center rounded border border-(--border) bg-(--surface) p-4 text-xs text-(--muted) ${className ?? ""}`}>
        Screenshot unavailable
      </div>
    );
  }

  // <img> can't set a custom X-Org-Id header, so the active org is appended
  // as ?orgId= instead - see the same fallback added to useJobEvents.ts.
  const activeOrgId = getActiveOrgId();
  const src = activeOrgId === undefined ? `/api/artifacts/${artifactId}` : `/api/artifacts/${artifactId}?orgId=${activeOrgId}`;

  return <img src={src} alt={alt} className={className} loading="lazy" onError={() => setFailed(true)} />;
}
