"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceEntry } from "./api";

export function usePolledDevices(opts: {
  fetchDevices: () => Promise<{ devices: DeviceEntry[]; runnerVersion: string; artifactBytes: number }>;
  intervalMs: number;
  isVisible: () => boolean;
}): { devices: DeviceEntry[]; runnerVersion: string; artifactBytes: number; loaded: boolean; refresh: () => void } {
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [runnerVersion, setRunnerVersion] = useState("unknown");
  const [artifactBytes, setArtifactBytes] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // Same stash-in-a-ref pattern as useRequireSession: callers pass a fresh
  // inline closure every render, but only its latest value should ever run -
  // an identity change must never retrigger the effect below (which would
  // tear down and restart the poll interval on every render).
  const fetchRef = useRef(opts.fetchDevices);
  fetchRef.current = opts.fetchDevices;

  const tick = useCallback(() => {
    fetchRef.current().then(
      (result) => {
        setDevices(result.devices);
        setRunnerVersion(result.runnerVersion);
        setArtifactBytes(result.artifactBytes);
        setLoaded(true);
      },
      () => {
        // A poll tick's own failure (transient network blip) must not become
        // an unhandled rejection every interval - the next tick retries.
      }
    );
  }, []);

  useEffect(() => {
    tick(); // always fetch on mount, regardless of visibility
    const id = setInterval(() => {
      if (opts.isVisible()) tick();
    }, opts.intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.intervalMs]);

  return { devices, runnerVersion, artifactBytes, loaded, refresh: tick };
}
