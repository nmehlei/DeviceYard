import type { CSSProperties } from "react";

/** A delayed, non-pulsing placeholder block. Building block for page-level loading
 * states - a blank "Loading…" text flashes to full content with nothing in
 * between, which reads as janky even when the underlying fetch is fast (the
 * actual page-transition network cost here measures ~150-200ms; the
 * complaint this addresses is perceived, not a real latency problem - see
 * the session this was added in). A skeleton roughly shaped like the real
 * content bridges that transition instead of flashing to blank. */
/** Purely decorative (aria-hidden) - the page wraps its skeleton group in
 * one `role="status"` region instead of announcing each block individually,
 * so screen readers hear "Loading" once per page, not once per placeholder. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden="true" className={`loading-placeholder rounded bg-(--border) ${className ?? ""}`} style={style} />;
}
