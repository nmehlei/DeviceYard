"use client";
import { useEffect, useState } from "react";
import type { ScreenState } from "./DeviceScreen";

const KEYS: Array<{ key: string; label: string }> = [
  { key: "back", label: "◀ Back" },
  { key: "home", label: "● Home" },
  { key: "recents", label: "■ Recents" },
  { key: "power", label: "⏻ Power" },
  { key: "volume-up", label: "🔊 Vol +" },
  { key: "volume-down", label: "🔉 Vol −" },
];

const WHY =
  "While a job is running, the screen is still frames a second apart instead of video, and control is not available. " +
  "That is deliberate: it uses a capture method that cannot disturb the job's own screen recording.";

export function ControlSidebar({ state, send }: { state: ScreenState; send: (message: object) => void }) {
  const [text, setText] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [showWhy, setShowWhy] = useState(false);

  useEffect(() => {
    if (state.releaseAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [state.releaseAt]);

  const mode = state.mode;
  const inControl = mode?.mode === "live-control" && mode.inControl === true;
  const canTake = mode?.mode === "snapshot-idle" && state.connection === "open" && state.webCodecs;
  const secondsLeft = state.releaseAt === undefined ? undefined : Math.max(0, Math.ceil((state.releaseAt - now) / 1000));

  return (
    <aside className="ops-box ops-pad flex w-56 shrink-0 flex-col gap-2" aria-label="Device controls">
      <div data-testid="screen-status" className="ops-small">
        {state.connection === "connecting" && "Connecting…"}
        {state.connection === "refused" && <span role="alert">This screen is available to farm admins only.</span>}
        {state.connection === "closed" && <span role="alert">Disconnected from the device.</span>}
        {state.connection === "open" && mode && (
          <>
            <strong>{mode.label}</strong>
            <span className="ops-muted"> — {mode.reason}</span>
          </>
        )}
      </div>

      {!state.webCodecs && (
        <p className="ops-small" role="alert">
          This browser cannot decode live video (it needs WebCodecs), so control is unavailable here.
        </p>
      )}

      {mode?.mode === "snapshot-job" && (
        <button type="button" className="ops-link ops-small text-left" onClick={() => setShowWhy((v) => !v)}>why?</button>
      )}
      {showWhy && <p className="ops-muted ops-small">{WHY}</p>}

      {canTake && <button type="button" className="ui-button" onClick={() => send({ type: "take-control" })}>Take control</button>}

      {inControl && (
        <>
          {KEYS.map(({ key, label }) => (
            <button key={key} type="button" className="ui-button" onClick={() => send({ type: "key", key })}>{label}</button>
          ))}
          <button type="button" className="ui-button" onClick={() => send({ type: "rotate" })}>↻ Rotate</button>

          <form
            className="flex flex-col gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (text) send({ type: "text", text });
              setText("");
            }}
          >
            <input className="ui-input" aria-label="Text to type on the device" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
            <div className="flex gap-1">
              <button type="submit" className="ui-button flex-1">Type</button>
              <button type="button" className="ui-button" onClick={() => send({ type: "key", key: "delete" })}>⌫</button>
              <button type="button" className="ui-button" onClick={() => send({ type: "key", key: "enter" })}>⏎</button>
            </div>
          </form>

          <div className="flex-1" />
          {secondsLeft !== undefined && (
            <p role="alert" className="ops-small">
              A job is waiting for this device — control releases in 0:{String(secondsLeft).padStart(2, "0")}
            </p>
          )}
          <button type="button" className="ui-button" onClick={() => send({ type: "release-control" })}>
            {secondsLeft !== undefined ? "Release now" : "Release control"}
          </button>
        </>
      )}

      {state.notice && !inControl && <p className="ops-small" role="status">{state.notice}</p>}
    </aside>
  );
}
