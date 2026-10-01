"use client";
import { useEffect, useState } from "react";
import { fetchDevices } from "./api";

/** id -> label for every device currently registered, enrolled or not
 * (`GET /api/devices` returns every registered device, not just enrolled
 * ones - that's what job pages need, since a job may have run on a device
 * that has since been disabled).
 *
 * A job payload carries only `deviceId`; the human label lives on the device
 * row, so the job views resolve it here. Deliberately fetched once (not
 * polled): the mapping changes only when a device is added or renamed, which
 * is not something a job page needs to track live. A failed lookup is not
 * worth surfacing on a job page - the raw serial is still a truthful answer
 * to "which device ran this", so callers fall back to it. */
export function useDeviceLabels(): Map<string, string> {
  const [labels, setLabels] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    fetchDevices()
      .then(({ devices }) => {
        if (!cancelled) setLabels(new Map(devices.map((d) => [d.id, d.label])));
      })
      .catch(() => {
        // Keep the empty map: every caller degrades to showing the serial.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return labels;
}

/** How a job's device is written in the UI: its label when we know one, the
 * raw id when we don't (the label fetch failed - `jobs.device_id` is
 * `ON DELETE SET NULL`, so a device removed from the pool since the job ran
 * cannot produce this case; its jobs render the em dash below instead), and
 * an em dash when the job has no device at all - queued jobs legitimately
 * have none. */
export function deviceDisplayName(deviceId: string | null, labels: Map<string, string>): string {
  // Falsy rather than `=== null`: a payload from an older server predating
  // jobs.device_id omits the field entirely, and an absent device must read
  // the same as an explicitly null one.
  if (!deviceId) return "—";
  return labels.get(deviceId) ?? deviceId;
}

/** List/detail views know the job state, so they can explain why no device is
 * present instead of rendering an ambiguous empty-looking dash. */
export function jobDeviceDisplayName(
  deviceId: string | null,
  status: "queued" | "running" | "done" | "failed",
  labels: Map<string, string>
): string {
  if (deviceId) return deviceDisplayName(deviceId, labels);
  return status === "queued" ? "Waiting for device" : "Not recorded";
}
