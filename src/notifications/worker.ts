import type { NotificationStore } from "./store";
import { renderEmail, type EmailData } from "./templates";
import { EmailTransportError, type EmailTransport } from "./transport";
import { log as structuredLog } from "../telemetry/log";
import { withSpan } from "../telemetry/tracer";

export interface QueuedEmail { to: string; data: EmailData; failed?: boolean }
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export class NotificationWorker {
  private active = false;
  constructor(private readonly store: NotificationStore, private readonly publicUrl: string,
    private readonly transport?: EmailTransport,
    // Injectable so tests can capture entries. The default routes through the
    // structured logger, so a delivery record carries trace_id/span_id and
    // reaches the collector like every other log line. `msg` is pulled out of
    // the entry to stay the message rather than just another field.
    private readonly log: (entry: Record<string, unknown>) => void = (entry) => {
      const { msg, ...fields } = entry;
      structuredLog.info(String(msg ?? "notification"), fields);
    }) {}

  async tick(): Promise<void> {
    if (this.active) return;
    this.active = true;
    // Its own root span per tick: background work has no inbound request to
    // hang off, so it starts a trace rather than joining one.
    return withSpan("notifications.tick", {}, () => this.tickInner());
  }

  private async tickInner(): Promise<void> {
    try {
      this.store.sweep();
      this.store.expandRunEvents((snapshot, user): QueuedEmail => ({
        to: user.email, failed: !!snapshot.failed,
        data: { kind: "run-result", recipientName: "there", organisationName: snapshot.orgName,
          jobId: snapshot.jobId, result: snapshot.failed ? "failed" : "passed",
          duration: duration(snapshot.durationMs), passedFlows: snapshot.passedCount,
          failedFlows: snapshot.failedCount, failedFlowNames: snapshot.failedFlows,
          actionUrl: `/notification-run?jobId=${encodeURIComponent(snapshot.jobId)}&orgId=${snapshot.orgId}` },
      }));
      if (!this.transport) return;
      for (let count = 0; count < 10; count++) {
        const delivery = this.store.claim();
        if (!delivery) break;
        try {
          if (!this.store.eligible(delivery)) {
            this.store.finish(delivery, "cancelled", "no_longer_eligible"); continue;
          }
          const payload = this.store.decode<QueuedEmail>(delivery);
          // Changing an account address must not deliver a queued message to
          // its old address, even if the account itself remains active.
          if (delivery.user_id && !this.store.db.get("SELECT 1 FROM users WHERE id=? AND email=?", delivery.user_id, payload.to)) {
            this.store.finish(delivery, "cancelled", "destination_changed"); continue;
          }
          const rendered = renderEmail(payload.data, this.publicUrl);
          await this.transport.send({ id: delivery.id, to: payload.to, ...rendered });
          this.store.finish(delivery, "accepted");
          this.log({ msg: "notification_attempt", notificationId: delivery.id, outcome: "accepted", attempt: delivery.attempts });
        } catch (err) {
          const code = err instanceof EmailTransportError ? err.code : "render_or_storage_failed";
          const retryable = code === "timeout" || code === "transport-failed";
          this.store.finish(delivery, retryable ? "retrying" : "failed", code);
          this.log({ msg: "notification_attempt", notificationId: delivery.id, outcome: retryable ? "retrying" : "failed", code, attempt: delivery.attempts });
        }
      }
    } catch {
      this.log({ msg: "notification_worker_failed", code: "worker_failure" });
    } finally { this.active = false; }
  }
}

export function startNotificationWorker(worker: NotificationWorker): () => void {
  const timer = setInterval(() => { void worker.tick(); }, 5_000);
  timer.unref();
  void worker.tick();
  return () => clearInterval(timer);
}
