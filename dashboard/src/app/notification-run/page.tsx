"use client";
import { useEffect, useState } from "react";
import { fetchSession } from "../../lib/api";
import { setActiveOrgId } from "../../lib/activeOrg";
import { navigate } from "../../lib/navigate";
export default function Page() {
  const [error, setError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const jobId = params.get("jobId"); const orgId = Number(params.get("orgId"));
    fetchSession().then((session) => {
      if (!jobId || !session.orgs.some((o) => o.id === orgId)) throw new Error("This run is unavailable or you no longer belong to its organisation.");
      setActiveOrgId(orgId); navigate(`/jobs/${encodeURIComponent(jobId)}`);
    }).catch((e) => {
      if (e.status === 401 || e.status === 403) navigate(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      else setError(e.message || "Could not open this run.");
    });
  }, []);
  return <main className="notify-page"><p role={error ? "alert" : "status"}>{error || "Opening your run…"}</p></main>;
}
