export function JobProgressBar({
  passed,
  failed,
  running,
  total,
}: {
  passed: number;
  failed: number;
  running: number;
  total: number;
}) {
  return (
    <div className="flex items-center gap-3 text-xs text-(--muted)">
      <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-(--border)">
        <div style={{ width: `${(passed / Math.max(total, 1)) * 100}%`, backgroundColor: "var(--status-passed)" }} />
        <div style={{ width: `${(failed / Math.max(total, 1)) * 100}%`, backgroundColor: "var(--status-failed)" }} />
        <div style={{ width: `${(running / Math.max(total, 1)) * 100}%`, backgroundColor: "var(--status-running)" }} />
      </div>
      <span>{passed} passed</span>
      {failed > 0 && <span style={{ color: "var(--status-failed)" }}>{failed} failed</span>}
      {running > 0 && <span style={{ color: "var(--status-running)" }}>{running} running</span>}
    </div>
  );
}
