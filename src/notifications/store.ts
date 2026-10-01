import { randomUUID } from "node:crypto";
import type { Db } from "../db/driver";
import { decryptToken, encryptToken, hashToken } from "../tokenCrypto";

export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 120_000;
export const DAY_MS = 86_400_000;
export type RunMode = "off" | "failures" | "all";
export interface QueueInput {
  eventKey: string;
  kind: string;
  userId?: number;
  orgId?: number;
  actionId?: string;
  incidentId?: string;
  payload: unknown;
  expiresAt?: number;
}
export interface Delivery {
  id: string; kind: string; user_id: number | null; org_id: number | null;
  action_id: string | null; incident_id: string | null; payload: string | null;
  status: string; attempts: number; expires_at: number; lease_owner: string;
}
export interface RunSnapshot {
  jobId: string; orgId: number; orgName: string; failed: number;
  passedCount: number; failedCount: number; durationMs: number; failedFlows: string[];
}

export class NotificationStore {
  constructor(public readonly db: Db, private readonly key: string, public readonly now = Date.now) {}

  transaction<T>(work: () => T): T {
    this.db.exec("SAVEPOINT notification_work");
    try {
      const result = work();
      this.db.exec("RELEASE notification_work");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK TO notification_work");
      this.db.exec("RELEASE notification_work");
      throw err;
    }
  }

  enqueue(input: QueueInput): string {
    const id = randomUUID();
    const now = this.now();
    this.db.run(`INSERT OR IGNORE INTO notification_outbox
      (id,event_key,kind,user_id,org_id,action_id,incident_id,payload,available_at,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, input.eventKey, input.kind,
      input.userId, input.orgId, input.actionId, input.incidentId,
      encryptToken(JSON.stringify(input.payload), this.key), now, input.expiresAt ?? now + DAY_MS, now, now);
    return this.db.get<{ id: string }>("SELECT id FROM notification_outbox WHERE event_key=?", input.eventKey)!.id;
  }

  decode<T>(delivery: Delivery): T {
    if (!delivery.payload) throw new Error("notification_payload_unavailable");
    return JSON.parse(decryptToken(delivery.payload, this.key)) as T;
  }

  claim(): Delivery | undefined {
    return this.transaction(() => {
      const now = this.now();
      const row = this.db.get<{ id: string }>(`SELECT id FROM notification_outbox
        WHERE expires_at>? AND attempts<? AND
          (kind<>'device-offline' OR EXISTS(SELECT 1 FROM notification_incidents i
            WHERE i.incident_id=notification_outbox.incident_id AND i.recovered_at IS NULL
            AND i.offline_since<=? AND i.last_observed_at>=?)) AND
          ((status IN ('queued','retrying') AND available_at<=?) OR (status='sending' AND lease_until<=?))
        ORDER BY CASE WHEN action_id IS NOT NULL THEN 0 ELSE 1 END, created_at, id LIMIT 1`, now, MAX_ATTEMPTS, now - 120_000, now - 45_000, now, now);
      if (!row) return undefined;
      this.db.run(`UPDATE notification_outbox SET status='sending', attempts=attempts+1,
        lease_until=?,lease_owner=?,updated_at=? WHERE id=?`, now + LEASE_MS, randomUUID(), now, row.id);
      return this.db.get<Delivery>("SELECT * FROM notification_outbox WHERE id=?", row.id);
    });
  }

  finish(delivery: Delivery, outcome: "accepted" | "cancelled" | "failed" | "retrying", code: string | null = null): void {
    this.transaction(() => {
      const current = this.db.get<{ lease_owner: string; status: string }>(
        "SELECT lease_owner,status FROM notification_outbox WHERE id=?", delivery.id);
      if (current?.lease_owner !== delivery.lease_owner || current.status !== "sending") return;
      const status = outcome === "retrying" && delivery.attempts >= MAX_ATTEMPTS ? "failed" : outcome;
      const retryAt = this.now() + Math.min(3_600_000, 30_000 * 2 ** (delivery.attempts - 1));
      this.db.run(`UPDATE notification_outbox SET status=?,error_code=?,updated_at=?,available_at=?,
        lease_owner=NULL,lease_until=NULL,payload=CASE WHEN ?='retrying' THEN payload ELSE NULL END WHERE id=?`,
        status, code, this.now(), retryAt, status, delivery.id);
      this.db.run("INSERT INTO notification_attempts(outbox_id,outcome,created_at) VALUES (?,?,?)",
        delivery.id, status, this.now());
    });
  }

  cancelAction(actionId: string, reason: "accepted" | "revoked" | "superseded" = "revoked"): void {
    this.db.run("UPDATE notification_actions SET consumed_at=?,closed_reason=? WHERE id=? AND (consumed_at IS NULL OR ?='accepted')", this.now(), reason, actionId, reason);
    this.db.run(`UPDATE notification_outbox SET status='cancelled',payload=NULL,updated_at=?,lease_owner=NULL
      WHERE action_id=? AND status IN ('queued','retrying','sending')`, this.now(), actionId);
  }

  eligible(delivery: Delivery): boolean {
    if (delivery.expires_at <= this.now()) return false;
    if (delivery.action_id) {
      const action = this.db.get<{ kind: string; email: string; user_id: number | null; org_id: number | null; created_by: number | null }>(
        "SELECT kind,email,user_id,org_id,created_by FROM notification_actions WHERE id=? AND consumed_at IS NULL AND expires_at>?",
        delivery.action_id, this.now());
      if (!action) return false;
      if (action.kind === "invitation") {
        return !!this.db.get(`SELECT 1 FROM orgs o JOIN users u ON u.id=?
          WHERE o.id=? AND o.archived_at IS NULL AND u.deactivated_at IS NULL
          AND (u.is_admin=1 OR EXISTS(SELECT 1 FROM org_members WHERE user_id=u.id AND org_id=o.id))`,
          action.created_by, action.org_id);
      }
      return !!this.db.get(`SELECT 1 FROM users WHERE id=? AND email=? AND deactivated_at IS NULL`, action.user_id, action.email);
    }
    const user = this.db.get<{ email_verified_at: number | null; is_admin: number }>(
      "SELECT email_verified_at,is_admin FROM users WHERE id=? AND deactivated_at IS NULL", delivery.user_id);
    if (!user || user.email_verified_at === null) return false;
    if (delivery.kind === "test") return user.is_admin === 1;
    if (delivery.kind === "run-result") {
      const preference = this.db.get<{ mode: RunMode }>(`SELECT p.mode FROM notification_preferences p
        JOIN orgs o ON o.id=p.org_id JOIN org_members m ON m.user_id=p.user_id AND m.org_id=p.org_id
        WHERE p.user_id=? AND p.org_id=? AND o.archived_at IS NULL`, delivery.user_id, delivery.org_id);
      if (!preference || preference.mode === "off") return false;
      const payload = this.decode<{ failed?: boolean }>(delivery);
      return preference.mode === "all" || payload.failed === true;
    }
    if (delivery.kind === "device-offline" || delivery.kind === "device-recovered") {
      if (!user.is_admin || !this.db.get("SELECT 1 FROM notification_health_preferences WHERE user_id=? AND enabled=1", delivery.user_id)) return false;
      if (delivery.kind === "device-offline") {
        return !!this.db.get(`SELECT 1 FROM notification_incidents WHERE incident_id=?
          AND offline_since<=? AND last_observed_at>=? AND recovered_at IS NULL`,
          delivery.incident_id, this.now() - 120_000, this.now() - 45_000);
      }
      return !!this.db.get("SELECT 1 FROM notification_outbox WHERE incident_id=? AND user_id=? AND kind='device-offline' AND status='accepted'", delivery.incident_id, delivery.user_id);
    }
    return false;
  }

  expandRunEvents(makePayload: (snapshot: RunSnapshot, user: { id: number; email: string }) => unknown): void {
    this.transaction(() => {
      const events = this.db.all<{ id: string; org_id: number; payload: string; recipients: string; created_at: number }>(
        "SELECT * FROM notification_events ORDER BY created_at LIMIT 100");
      for (const event of events) {
        if (event.created_at + DAY_MS > this.now()) {
          const snapshot = JSON.parse(event.payload) as RunSnapshot;
          for (const userId of JSON.parse(event.recipients) as number[]) {
            const user = this.db.get<{ id: number; email: string }>("SELECT id,email FROM users WHERE id=?", userId);
            if (user) this.enqueue({ eventKey: `${event.id}:${userId}`, kind: "run-result", userId,
              orgId: event.org_id, payload: makePayload(snapshot, user), expiresAt: event.created_at + DAY_MS });
          }
        }
        this.db.run("DELETE FROM notification_events WHERE id=?", event.id);
      }
    });
  }

  /** Persisted buckets survive restarts; hash caller identifiers, never tokens. */
  allow(bucket: string, limit: number, windowMs: number): boolean {
    const key = hashToken(bucket);
    return this.transaction(() => {
      this.db.run(`INSERT INTO notification_rate_limits(bucket,count,reset_at) VALUES (?,1,?)
        ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
        reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END`, key, this.now() + windowMs, this.now(), this.now());
      return this.db.get<{ count: number }>("SELECT count FROM notification_rate_limits WHERE bucket=?", key)!.count <= limit;
    });
  }

  history(offset = 0) {
    return this.db.all(`SELECT id,kind,status,attempts,error_code AS errorCode,created_at AS createdAt,
      updated_at AS updatedAt FROM notification_outbox ORDER BY created_at DESC,id LIMIT 25 OFFSET ?`, offset);
  }

  metrics() {
    return this.db.get<{ queued: number; accepted: number; failed: number; oldestQueuedAt: number | null }>(`SELECT
      COALESCE(SUM(status IN ('queued','retrying','sending')),0) AS queued,
      COALESCE(SUM(status='accepted'),0) AS accepted, COALESCE(SUM(status='failed'),0) AS failed,
      MIN(CASE WHEN status IN ('queued','retrying','sending') THEN created_at END) AS oldestQueuedAt
      FROM notification_outbox`)!;
  }

  sweep(): void {
    const now = this.now();
    this.db.run(`UPDATE notification_outbox SET status='failed',error_code='expired_or_exhausted',
      payload=NULL,lease_owner=NULL,updated_at=? WHERE status IN ('queued','retrying','sending')
      AND (expires_at<=? OR (attempts>=? AND lease_until<=?))`, now, now, MAX_ATTEMPTS, now);
    this.db.run("DELETE FROM notification_outbox WHERE updated_at<? AND status IN ('accepted','cancelled','failed')", now - 30 * DAY_MS);
    this.db.run("DELETE FROM notification_actions WHERE expires_at<?", now - 30 * DAY_MS);
    this.db.run("DELETE FROM notification_events WHERE created_at<?", now - DAY_MS);
    this.db.run("DELETE FROM notification_rate_limits WHERE reset_at<=?", now);
    this.db.run("DELETE FROM notification_recoveries WHERE recovered_at<?", now - DAY_MS);
  }
}
