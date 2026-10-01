"use client";
import { useState } from "react";
import { orgScopedFetch } from "../lib/activeOrg";

export function LogViewer({
  stepId,
  preview,
  stderrPreview,
  fetchImpl,
}: {
  stepId: number;
  preview: string | null;
  stderrPreview?: string | null;
  fetchImpl?: typeof fetch;
}) {
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [full, setFull] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const shown = full ?? (stream === "stdout" ? preview : stderrPreview) ?? "";

  const loadFull = async () => {
    setLoading(true);
    try {
      // Defaults to orgScopedFetch(), not plain fetch, so this real-world
      // call carries X-Org-Id in production - fetchImpl is only ever
      // supplied by tests.
      const fetcher = fetchImpl ?? orgScopedFetch();
      const res = await fetcher(`/api/flow-runs/${stepId}/log?stream=${stream}`, { credentials: "include" });
      setFull(res.ok ? await res.text() : "log unavailable");
    } catch {
      setFull("log unavailable");
    } finally {
      setLoading(false);
    }
  };

  const switchStream = (next: "stdout" | "stderr") => {
    setStream(next);
    setFull(undefined);
  };

  return (
    <div className="rounded border border-(--border) bg-(--background)">
      <div className="flex items-center justify-between border-b border-(--border) px-3 py-1.5">
        <div className="flex gap-2 text-xs">
          <button
            onClick={() => switchStream("stdout")}
            className={stream === "stdout" ? "text-(--foreground)" : "text-(--muted)"}
          >
            stdout
          </button>
          <button
            onClick={() => switchStream("stderr")}
            className={stream === "stderr" ? "text-(--foreground)" : "text-(--muted)"}
          >
            stderr
          </button>
        </div>
        <button onClick={loadFull} disabled={loading} className="text-xs text-(--status-running)">
          {loading ? "Loading…" : "View full log"}
        </button>
      </div>
      <pre className="mono max-h-64 overflow-auto p-3 text-xs text-(--foreground)">{shown}</pre>
    </div>
  );
}
