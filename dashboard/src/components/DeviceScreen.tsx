"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { FrameTag, readFrameTag } from "../lib/frameTags";
import { codecStringFromAnnexB } from "../lib/avcCodec";
import { normalisedPoint } from "../lib/pointerMapping";

export type ServerMessage =
  | { type: "mode"; mode: "snapshot-job" | "snapshot-idle" | "live-control"; label: string; reason: string; inControl?: boolean }
  | { type: "error"; message: string }
  | { type: "edition-warning"; message: string }
  | { type: "control-denied"; reason: string }
  | { type: "release-pending"; releaseAt: number; reason: string }
  | { type: "release-cancelled" }
  | { type: "control-ended"; reason: string };

export interface ScreenState {
  connection: "connecting" | "open" | "closed" | "refused";
  mode?: Extract<ServerMessage, { type: "mode" }>;
  notice?: string;
  releaseAt?: number;
  webCodecs: boolean;
}

/**
 * The device screen: PNG snapshots or H.264 live video on one canvas-backed
 * surface, plus pointer input while in control. Frame decoding follows two
 * measured facts: a keyframe must be preceded by the configuration packet, and
 * delta frames before the first keyframe are undecodable and dropped.
 */
export function DeviceScreen({
  deviceId,
  onState,
  register,
}: {
  deviceId: string;
  onState: (state: ScreenState) => void;
  /** Hands the parent a function to send control messages over this socket. */
  register: (send: (message: object) => void) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const [snapshotUrl, setSnapshotUrl] = useState<string>();
  const snapshotRef = useRef<string | undefined>(undefined);
  const [live, setLive] = useState(false);
  const [connection, setConnection] = useState<ScreenState["connection"]>("connecting");
  const inControlRef = useRef(false);
  const state = useRef<ScreenState>({ connection: "connecting", webCodecs: typeof VideoDecoder !== "undefined" });

  const publish = useCallback((patch: Partial<ScreenState>) => {
    state.current = { ...state.current, ...patch };
    onState(state.current);
  }, [onState]);

  useEffect(() => {
    publish({});
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${window.location.host}/api/devices/${encodeURIComponent(deviceId)}/control`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    register((message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    });

    let decoder: VideoDecoder | undefined;
    let config: Uint8Array | undefined;
    let haveKeyframe = false;
    let timestamp = 0;
    let closedByUs = false;
    // Browsers fire "error" then "close" for a refused upgrade (never
    // "open"). Without tracking this, the close listener below overwrites
    // "refused" with "closed", and a non-admin never sees the admin-only
    // message - just "Disconnected from the device."
    let everOpened = false;

    const resetDecoder = () => {
      try { decoder?.close(); } catch { /* already closed */ }
      decoder = undefined;
      haveKeyframe = false;
    };

    const ensureDecoder = () => {
      if (decoder || !config || typeof VideoDecoder === "undefined") return;
      const codec = codecStringFromAnnexB(config);
      if (!codec) return;
      decoder = new VideoDecoder({
        output: (frame) => {
          const canvas = canvasRef.current;
          if (canvas) {
            if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
            if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
            canvas.getContext("2d")?.drawImage(frame, 0, 0);
          }
          frame.close();
        },
        error: (err) => {
          publish({ notice: `video decoding failed: ${err.message}` });
          resetDecoder();
        },
      });
      // No `description`: WebCodecs then expects Annex B, which is what scrcpy sends.
      decoder.configure({ codec, optimizeForLatency: true });
    };

    socket.addEventListener("open", () => { everOpened = true; publish({ connection: "open" }); setConnection("open"); });

    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as ServerMessage;
        switch (message.type) {
          case "mode": {
            const wasLive = state.current.mode?.mode === "live-control";
            const isLive = message.mode === "live-control";
            inControlRef.current = isLive && message.inControl === true;
            setLive(isLive);
            if (!isLive) { resetDecoder(); config = undefined; }
            publish({
              mode: message,
              // The server sends control-ended IMMEDIATELY BEFORE this mode
              // change. Clearing the notice here would erase the only
              // explanation of why the video just stopped - so a transition
              // OUT of live control keeps it; any other transition clears.
              notice: wasLive && !isLive ? state.current.notice : undefined,
              ...(isLive ? {} : { releaseAt: undefined }),
            });
            return;
          }
          case "edition-warning":
          case "error":
            publish({ notice: message.message });
            return;
          case "control-denied":
            publish({ notice: `Control not available: ${message.reason}` });
            return;
          case "release-pending":
            publish({ releaseAt: message.releaseAt, notice: message.reason });
            return;
          case "release-cancelled":
            publish({ releaseAt: undefined, notice: undefined });
            return;
          case "control-ended":
            // Arrives immediately before the mode reverts; the mode handler
            // deliberately preserves this notice across that one transition.
            publish({ releaseAt: undefined, notice: `Control ended: ${message.reason}` });
            return;
        }
      }

      const tagged = readFrameTag(new Uint8Array(event.data as ArrayBuffer));
      if (!tagged) return;
      switch (tagged.tag) {
        case FrameTag.Png: {
          const url = URL.createObjectURL(new Blob([new Uint8Array(tagged.payload)], { type: "image/png" }));
          const previous = snapshotRef.current;
          snapshotRef.current = url;
          setSnapshotUrl(url);
          if (previous) URL.revokeObjectURL(previous);
          return;
        }
        case FrameTag.H264Config:
          resetDecoder();
          config = tagged.payload.slice();
          ensureDecoder();
          return;
        case FrameTag.H264Key:
          ensureDecoder();
          if (!decoder || !config) return;
          decoder.decode(new EncodedVideoChunk({
            type: "key",
            timestamp: (timestamp += 16_667),
            // Measured: the keyframe arrives without SPS/PPS, so they are prepended.
            data: concat(config, tagged.payload),
          }));
          haveKeyframe = true;
          return;
        case FrameTag.H264Delta:
          if (!decoder || !haveKeyframe) return; // undecodable without a preceding keyframe
          decoder.decode(new EncodedVideoChunk({ type: "delta", timestamp: (timestamp += 16_667), data: tagged.payload }));
          return;
      }
    });

    socket.addEventListener("close", () => {
      if (closedByUs) return;
      // A close that never saw "open" is the refused-upgrade signature; the
      // "error" listener already recorded that, and "closed" must not
      // overwrite it - it's a strictly less specific description of the same
      // event.
      if (!everOpened) return;
      publish({ connection: "closed" });
      setConnection("closed");
    });
    socket.addEventListener("error", () => {
      if (closedByUs) return;
      publish({ connection: "refused" });
      setConnection("refused");
    });

    return () => {
      closedByUs = true;
      socket.close();
      resetDecoder();
      if (snapshotRef.current) URL.revokeObjectURL(snapshotRef.current);
      snapshotRef.current = undefined;
    };
  }, [deviceId, publish, register]);

  const sendTouch = (event: React.PointerEvent<HTMLCanvasElement>, action: "down" | "move" | "up" | "cancel") => {
    if (!inControlRef.current) return;
    const point = normalisedPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    if (!point && action === "down") return; // a stray click outside the screen is not a tap
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = point?.x ?? (event.clientX - rect.left) / rect.width;
    const y = point?.y ?? (event.clientY - rect.top) / rect.height;
    socket.send(JSON.stringify({ type: "touch", action, pointerId: event.pointerId, x, y }));
  };

  const dimmed = connection === "closed" || connection === "refused";

  return (
    <div className="flex h-full items-center justify-center" style={dimmed ? { opacity: 0.4 } : undefined}>
      {live ? (
        <canvas
          ref={canvasRef}
          data-testid="device-canvas"
          className="h-full w-auto rounded border border-(--border)"
          style={{ touchAction: "none" }}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); sendTouch(e, "down"); }}
          onPointerMove={(e) => { if (e.buttons) sendTouch(e, "move"); }}
          onPointerUp={(e) => sendTouch(e, "up")}
          onPointerCancel={(e) => sendTouch(e, "cancel")}
        />
      ) : snapshotUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={snapshotUrl} alt={`Screen of ${deviceId}`} className="h-full w-auto rounded border border-(--border)" />
      ) : (
        <p className="ops-muted ops-small">Waiting for the first frame…</p>
      )}
    </div>
  );
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
