import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { NotificationStore, DAY_MS } from "./store";
import { duration, type QueuedEmail } from "./worker";
import { log } from "../telemetry/log";
import { withSpan } from "../telemetry/tracer";

export const OFFLINE_DEBOUNCE_MS = 120_000;
export const HEALTH_POLL_MS = 15_000;
type Incident = { incident_id: string | null; offline_since: number | null; recovered_at: number | null; last_observed_at: number; alerted: number };

export class DeviceHealthMonitor {
  private active = false;
  constructor(private readonly store: NotificationStore,
    private readonly probe: () => Promise<Map<string, boolean>> = probeDevices) {}

  async tick(): Promise<void> {
    if (this.active) return;
    this.active = true;
    // Its own root span per tick - see the note in worker.ts.
    return withSpan("device.healthcheck", {}, () => this.tickInner());
  }

  private async tickInner(): Promise<void> {
    try {
      const states = await this.probe();
      const devices = this.store.db.all<{ id: string; label: string }>("SELECT id,label FROM devices");
      for (const device of devices) this.observe(device.id, device.label, states.get(device.id) ?? false);
      this.expandRecoveries();
    } catch {
      log.info("notification_health_probe_failed", { code: "device_probe_failed" });
    } finally { this.active = false; }
  }

  observe(deviceId: string, deviceName: string, online: boolean): void {
    this.store.transaction(() => {
      const { db } = this.store; const now = this.store.now();
      const previous = db.get<Incident>("SELECT * FROM notification_incidents WHERE device_id=?", deviceId);
      if (!previous) {
        // The first observation is a baseline, not a transition. A second
        // confirmed offline observation starts the debounce even on cold boot.
        db.run("INSERT INTO notification_incidents(device_id,last_observed_at) VALUES (?,?)", deviceId, now);
        return;
      }
      if (online) {
        const recoveredAt = previous.recovered_at ?? now;
        if (previous.incident_id && now - recoveredAt < DAY_MS) {
          db.run("INSERT OR IGNORE INTO notification_recoveries VALUES (?,?,?,?)", previous.incident_id, deviceName, previous.offline_since, recoveredAt);
          const recipients = db.all<{ user_id: number; email: string }>(`SELECT q.user_id,u.email FROM notification_outbox q
            JOIN users u ON u.id=q.user_id WHERE q.incident_id=? AND q.kind='device-offline' AND q.status='accepted'`, previous.incident_id);
          for (const user of recipients) this.store.enqueue({ eventKey: `recovery:${previous.incident_id}:${user.user_id}`,
            kind: "device-recovered", userId: user.user_id, incidentId: previous.incident_id,
            payload: { to: user.email, data: { kind: "device-recovered", deviceName,
              recoveredAt: new Date(recoveredAt).toISOString(), outageDuration: duration(recoveredAt - previous.offline_since!), actionUrl: "/devices" } } satisfies QueuedEmail });
          db.run(`UPDATE notification_outbox SET status='cancelled',payload=NULL,lease_owner=NULL,updated_at=?
            WHERE incident_id=? AND kind='device-offline' AND status IN ('queued','retrying')`, now, previous.incident_id);
        }
        // Keep the recovered incident briefly: an SMTP submission already in
        // flight can be accepted after this observation, and the next poll
        // must still send that recipient a recovery.
        db.run("UPDATE notification_incidents SET recovered_at=?,last_observed_at=? WHERE device_id=?", recoveredAt, now, deviceId);
        return;
      }
      // An unobserved gap cannot prove continuous outage. Retain accepted
      // incidents, but restart a pending debounce after missed observations.
      const gap = now - previous.last_observed_at > HEALTH_POLL_MS * 3;
      const continued = previous.recovered_at === null;
      const accepted = previous.incident_id && db.get("SELECT 1 FROM notification_outbox WHERE incident_id=? AND kind='device-offline' AND status='accepted'", previous.incident_id);
      const since = continued && previous.offline_since !== null && (!gap || accepted) ? previous.offline_since : now;
      const incidentId = continued && previous.incident_id ? previous.incident_id : randomUUID();
      db.run("UPDATE notification_incidents SET incident_id=?,offline_since=?,recovered_at=NULL,alerted=?,last_observed_at=? WHERE device_id=?", incidentId, since, continued ? previous.alerted : 0, now, deviceId);
      if ((continued && previous.alerted) || now - since < OFFLINE_DEBOUNCE_MS) return;
      const recipients = db.all<{ id: number; email: string }>(`SELECT u.id,u.email FROM users u
        JOIN notification_health_preferences p ON p.user_id=u.id
        WHERE p.enabled=1 AND u.is_admin=1 AND u.deactivated_at IS NULL AND u.email_verified_at IS NOT NULL`);
      for (const user of recipients) this.store.enqueue({ eventKey: `offline:${incidentId}:${user.id}`,
        kind: "device-offline", userId: user.id, incidentId,
        payload: { to: user.email, data: { kind: "device-offline", deviceName,
          observedAt: new Date(since).toISOString(), actionUrl: "/devices" } } satisfies QueuedEmail });
      db.run("UPDATE notification_incidents SET alerted=1 WHERE device_id=?", deviceId);
    });
  }

  expandRecoveries(): void {
    this.store.transaction(() => {
      const recoveries = this.store.db.all<{ incident_id: string; device_name: string; offline_since: number; recovered_at: number }>(
        "SELECT * FROM notification_recoveries WHERE recovered_at>?", this.store.now() - DAY_MS);
      for (const recovery of recoveries) {
        const recipients = this.store.db.all<{ user_id: number; email: string }>(`SELECT q.user_id,u.email FROM notification_outbox q
          JOIN users u ON u.id=q.user_id WHERE q.incident_id=? AND q.kind='device-offline' AND q.status='accepted'`, recovery.incident_id);
        for (const user of recipients) this.store.enqueue({ eventKey: `recovery:${recovery.incident_id}:${user.user_id}`,
          kind: "device-recovered", userId: user.user_id, incidentId: recovery.incident_id,
          payload: { to: user.email, data: { kind: "device-recovered", deviceName: recovery.device_name,
            recoveredAt: new Date(recovery.recovered_at).toISOString(), outageDuration: duration(recovery.recovered_at - recovery.offline_since), actionUrl: "/devices" } } satisfies QueuedEmail });
      }
    });
  }
}

export function probeDevices(): Promise<Map<string, boolean>> {
  return new Promise((resolve, reject) => {
    execFile("adb", ["devices"], { timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error("device_probe_failed")); return; }
      const states = new Map<string, boolean>();
      for (const line of stdout.split("\n")) {
        const [id, state] = line.trim().split(/\s+/);
        if (id && !line.startsWith("List of devices")) states.set(id, state === "device");
      }
      resolve(states);
    });
  });
}

export function startDeviceHealthMonitor(monitor: DeviceHealthMonitor): () => void {
  const timer = setInterval(() => { void monitor.tick(); }, HEALTH_POLL_MS); timer.unref();
  void monitor.tick();
  return () => clearInterval(timer);
}
