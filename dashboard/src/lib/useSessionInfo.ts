"use client";
import { useEffect, useState } from "react";
import { fetchSession, type SessionInfo } from "./api";

/** Best-effort, silent on failure - NavBar renders fine with no session info
 * (just no org pill, no Admin link) while a page's own useRequireSession is
 * what actually redirects to /login for a truly invalid session. This hook
 * is presentation-only, never a source of auth truth. */
export function useSessionInfo(): SessionInfo | undefined {
  const [info, setInfo] = useState<SessionInfo | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}
