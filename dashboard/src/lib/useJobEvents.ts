"use client";
import { useEffect, useRef, useState } from "react";
import { fetchJobDetail, type JobDetail } from "./api";
import { getActiveOrgId, orgScopedFetch } from "./activeOrg";

export type JobEventsStatus = "connecting" | "live" | "reconnecting" | "not-found";

// A single shared instance, not one created per render/hook-call: orgScopedFetch()
// returns a stateless wrapper (it looks up the active org fresh on every actual
// fetch call), so reusing one instance as the default keeps its identity stable
// across renders - a fresh closure on every render would change the effect
// below's dependency array every time and re-subscribe the EventSource on every
// render, not just when jobId/EventSourceImpl/fetchImpl genuinely change.
const defaultOrgScopedFetch = orgScopedFetch();

export function useJobEvents(
  jobId: string,
  deps: { EventSourceImpl?: typeof EventSource; fetchImpl?: typeof fetch } = {}
): { detail: JobDetail | undefined; status: JobEventsStatus } {
  // deps.EventSourceImpl is read here (component body scope) but NOT
  // resolved against the bare `EventSource` global here - that fallback is
  // deferred into the effect below. Unlike `fetch`, which Node 18+ provides
  // as a real global, `EventSource` has no Node.js global at all. Next's
  // static export prerenders every page's component body once, server-side,
  // during `next build` - client effects never run in that pass, but the
  // component body does. Eagerly evaluating `deps.EventSourceImpl ??
  // EventSource` here throws `ReferenceError: EventSource is not defined`
  // during the build the moment a real page (Task 10) calls this hook
  // without passing EventSourceImpl - which is every real usage.
  const eventSourceOverride = deps.EventSourceImpl;
  // Falls back to the org-scoped default, not bare `fetch` - this same
  // fetchImpl is used for the reconnect-poll fallback below (fetchJobDetail),
  // which needs X-Org-Id just as much as the initial page load does. Passing
  // bare fetch here used to silently strip org context from every job whose
  // EventSource connection ended (including the normal case: the server
  // closes the stream once a job reaches done/failed), 404-ing the fallback
  // fetch and leaving the UI stuck on "reconnecting" forever.
  const fetchImpl = deps.fetchImpl ?? defaultOrgScopedFetch;
  const [detail, setDetail] = useState<JobDetail | undefined>(undefined);
  const [status, setStatus] = useState<JobEventsStatus>("connecting");
  const hasConnectedRef = useRef(false);

  useEffect(() => {
    hasConnectedRef.current = false;
    setStatus("connecting");
    setDetail(undefined);

    // Resolved here, not in the component body - this effect only runs
    // client-side, post-hydration, so the bare EventSource reference is safe.
    const EventSourceImpl = eventSourceOverride ?? EventSource;
    // EventSource can't set a custom X-Org-Id header, so the active org is
    // appended as ?orgId= instead - the cookie-auth fallback src/auth.ts's
    // requireAuth added for exactly this class of request.
    const activeOrgId = getActiveOrgId();
    const url =
      activeOrgId === undefined
        ? `/api/jobs/${encodeURIComponent(jobId)}/events`
        : `/api/jobs/${encodeURIComponent(jobId)}/events?orgId=${activeOrgId}`;
    const source = new EventSourceImpl(url);

    source.onmessage = (ev: MessageEvent<string>) => {
      // GET /api/jobs/:id/events sends the full current job+steps payload on
      // every message (connect, then each increment) - this is a wholesale
      // replace, never a merge, matching what the endpoint actually sends.
      const payload = JSON.parse(ev.data) as JobDetail;
      hasConnectedRef.current = true;
      setDetail(payload);
      setStatus("live");
    };

    source.onerror = () => {
      source.close();
      if (!hasConnectedRef.current) {
        // Never connected at all - most likely a 404 (job not found) or a
        // 401 (no/expired session). fetchJobDetail resolves undefined only
        // for 404; a 401 rejects (ApiError) - this hook does not redirect on
        // that itself (the page's own useRequireSession gate, Task 6/10,
        // owns the redirect), so the rejection is swallowed here rather than
        // left as an unhandled promise rejection on every failed reconnect.
        fetchJobDetail(jobId, fetchImpl).then(
          (result) => {
            if (result === undefined) {
              setStatus("not-found");
            } else {
              setDetail(result);
              setStatus("live");
            }
          },
          () => {
            // Non-404 failure (401, 502, network error) - leave status as
            // "connecting"; the consuming page's own session/error handling
            // is responsible for what the user sees next.
          }
        );
        return;
      }
      // Connected at least once, then the stream broke - a client-side
      // mitigation for cycle 1's missing SSE heartbeat/retry: (tracked in
      // docs/open_issues.md), not a fix for it. One poll, not a reconnect
      // loop: if the job is terminal this is also the last state it needs.
      setStatus("reconnecting");
      fetchJobDetail(jobId, fetchImpl).then(
        (result) => {
          // Fresh data in hand - "live" reflects that accurately even though
          // the transport is closed, and matches what onmessage already does
          // for every SSE frame. Without this, "reconnecting…" stays on
          // screen forever once the poll succeeds - this fallback runs
          // exactly once (no retry loop), so there is no later message that
          // would otherwise clear it.
          if (result !== undefined) {
            setDetail(result);
            setStatus("live");
          }
        },
        () => {
          // Same reasoning as above: swallow here, not this hook's job to redirect.
        }
      );
    };

    return () => source.close();
  }, [jobId, eventSourceOverride, fetchImpl]);

  return { detail, status };
}
