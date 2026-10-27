"use client";
import { useEffect, useState } from "react";
import { useRequireSession } from "../../lib/useRequireSession";
import { fetchVersion, type VersionInfo } from "../../lib/api";
import { Skeleton } from "../../components/Skeleton";
import { Brand } from "../../components/Brand";

const UNKNOWN: VersionInfo = { version: "unknown", maestroVersion: "unknown" };

export default function AboutPage() {
  const sessionState = useRequireSession();
  const [info, setInfo] = useState<VersionInfo | undefined>(undefined);

  useEffect(() => {
    if (sessionState !== "ok") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => fetchVersion().then(value => {
      if (cancelled) return;
      setInfo(value);
      if (value.maestroPending) timer = setTimeout(refresh, 1000);
    }).catch(() => { if (!cancelled) setInfo(UNKNOWN); });
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionState]);

  if (sessionState !== "ok") {
    return (
      <main className="p-6" role="status" aria-label="Loading">
        <Skeleton className="mb-4 h-6 w-20" />
        <Skeleton className="h-28 w-full max-w-xl" />
      </main>
    );
  }

  return (
    <main className="p-6">
      <h1 className="mb-4 text-lg text-(--foreground)">About</h1>
      <div className="max-w-xl rounded-lg border border-(--border) bg-(--surface) p-5">
        <div className="mb-6"><Brand size={56} /></div>
        <dl className="text-sm">
          <dt className="text-xs uppercase tracking-wide text-(--muted)">{info?.edition === "pro" ? "DeviceYard Pro" : "DeviceYard"}</dt>
          <dd className="mono mt-1 text-(--foreground)">
            {info?.version ?? <Skeleton className="h-4 w-16" />}
          </dd>

          {info?.edition === "pro" && info.coreVersion && <>
            <dt className="mt-3 text-xs uppercase tracking-wide text-(--muted)">Community core</dt>
            <dd className="mono mt-1 text-(--foreground)">{info.coreVersion}</dd>
          </>}

          <dt className="mt-3 text-xs uppercase tracking-wide text-(--muted)">Maestro</dt>
          <dd className="mono mt-1 text-(--foreground)">
            {/* Maestro startup runs independently of the application version. */}
            {info?.maestroPending ? <span role="status" className="text-(--muted)">Checking installed version…</span> : info?.maestroVersion ?? <Skeleton className="h-4 w-24" />}
          </dd>
        </dl>
      </div>
    </main>
  );
}
