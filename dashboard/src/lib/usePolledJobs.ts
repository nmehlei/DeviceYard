"use client";
import { useEffect, useState } from "react";
import type { JobListEntry } from "./api";

export function usePolledJobs(opts: {
  fetchJobs: () => Promise<JobListEntry[]>;
  intervalMs: number;
  isVisible: () => boolean;
}): { jobs: JobListEntry[]; loaded: boolean } {
  const [jobs, setJobs] = useState<JobListEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      opts.fetchJobs().then(
        (result) => {
          if (!cancelled) {
            setJobs(result);
            setLoaded(true);
          }
        },
        () => {
          // A poll tick's own failure (transient network blip, or a 401 that
          // the page's separate useRequireSession guard is already handling)
          // must not become an unhandled rejection every ~12s - the next
          // tick simply retries. Auth redirects are this hook's caller's
          // job, not this hook's.
        }
      );
    };
    tick(); // always fetch on mount, regardless of visibility
    const id = setInterval(() => {
      // Paused, not stopped, while the tab is hidden - avoids burning cycles
      // on a backgrounded tab (spec, "list live-updates" decision) without
      // tearing down and re-establishing the interval on every visibility
      // flicker.
      if (opts.isVisible()) tick();
    }, opts.intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.intervalMs]);

  return { jobs, loaded };
}
