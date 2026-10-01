"use client";
import { useEffect, useState } from "react";
import { ApiError, fetchSession } from "./api";
import { navigate } from "./navigate";

/** Every page behind a login wall calls this the same way, with no probe
 * function to inject any more - fetchSession() is both the auth check and
 * (via its own side effect) what picks a default active org for a fresh
 * tab. See fetchSession's own comment for why that side effect lives there
 * instead of here. */
export function useRequireSession(): "checking" | "ok" | "redirecting" {
  const [state, setState] = useState<"checking" | "ok" | "redirecting">("checking");

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then(() => {
        if (!cancelled) setState("ok");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setState("redirecting");
          navigate("/login");
          return;
        }
        setState("ok");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
