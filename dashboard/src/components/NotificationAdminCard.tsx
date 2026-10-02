"use client";
import { useEffect, useState } from "react";
import { notificationRequest } from "../lib/notifications";
import { EmailPreview } from "./EmailPreview";
interface Readiness { status: string; error?: string; sender?: string; senderName?: string; metrics: { queued: number; accepted: number; failed: number } }
interface Delivery { id: string; kind: string; status: string; attempts: number; errorCode?: string; createdAt: number }
const statusLabels: Record<string, string> = { queued: "Queued", sending: "Sending", retrying: "Retrying", accepted: "Accepted by mail server", failed: "Failed", cancelled: "Cancelled" };
export function NotificationAdminCard() {
  const [ready, setReady] = useState<Readiness>(); const [items, setItems] = useState<Delivery[]>([]); const [offset, setOffset] = useState(0);
  const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => Promise.all([notificationRequest<Readiness>("/api/admin/notifications"), notificationRequest<{ items: Delivery[] }>(`/api/admin/notifications/history?offset=${offset}`)])
      .then(([readiness, history]) => { if (!cancelled) { setReady(readiness); setItems(history.items); setError(""); } }).catch((e) => { if (!cancelled) setError(e.message); });
    void refresh(); const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [offset, revision]);
  async function test() {
    setBusy(true); setError("");
    try { await notificationRequest("/api/admin/notifications/test", {}); setMessage("Test email queued for your verified account address."); setOffset(0); setRevision((value) => value + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "Test email failed."); } finally { setBusy(false); }
  }
  return <div className="space-y-6">
    {error && <p role="alert" className="notify-error">{error}</p>}{message && <p role="status" className="notify-success">{message}</p>}
    <section className="notify-card"><p className="notify-eyebrow">Delivery foundation</p><h2 className="mb-3 text-xl font-semibold">Email administration</h2>
      {!ready ? <p role="status">Loading email configuration…</p> : <><span className="notify-tag">{ready.status === "ready" ? "SMTP configured" : ready.status === "invalid" ? "Configuration needs attention" : "Email disabled"}</span>
        <p className="my-4 text-sm text-(--muted)">{ready.sender ? `${ready.senderName} · ${ready.sender}` : "Configure SMTP_HOST, SMTP_PORT, SMTP_TLS, SMTP_FROM and PUBLIC_APP_URL in your deployment."}</p>
        {ready.error && <p className="mb-4 text-sm text-(--status-failed)">Configuration: {ready.error.replaceAll("-", " ")}</p>}
        <div className="mb-5 grid grid-cols-3 gap-3">{[["Queued", ready.metrics.queued], ["Accepted", ready.metrics.accepted], ["Failed", ready.metrics.failed]].map(([name, count]) => <div key={name} className="rounded-lg bg-(--background) p-4"><strong className="block text-2xl">{count}</strong><span className="text-xs text-(--muted)">{name}</span></div>)}</div>
        <button className="notify-button" disabled={busy || ready.status !== "ready"} onClick={test}>{busy ? "Queueing…" : "Send me a test email"}</button><p className="mt-3 text-xs text-(--muted)">Sends only to your verified account address. Limited to one test per minute.</p>
      </>}
    </section>
    <EmailPreview allTemplates />
    <section className="notify-card"><h2 className="mb-2 text-lg font-semibold">Delivery history</h2><p className="mb-5 text-xs leading-6 text-(--muted)">SMTP acceptance confirms that the mail server accepted a message. It does not confirm inbox delivery. History is retained for 30 days.</p>
      {!items.length ? <p className="py-8 text-sm text-(--muted)">No notifications here yet. Your next update will appear here.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-xs text-(--muted)"><th className="pb-3">Notification</th><th>Status</th><th>Attempts</th><th>Created</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className="border-t border-(--border)"><td className="py-4 pr-3">{item.kind.replaceAll("-", " ")}</td><td className="pr-3">{statusLabels[item.status] ?? item.status}{item.errorCode && <span className="mt-1 block text-xs text-(--muted)">{item.errorCode.replaceAll("_", " ").replaceAll("-", " ")}</span>}</td><td>{item.attempts}</td><td className="whitespace-nowrap text-xs text-(--muted)">{new Date(item.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}
      <div className="mt-4 flex gap-3"><button className="notify-chip" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>Newer</button><button className="notify-chip" disabled={items.length < 25} onClick={() => setOffset(offset + 25)}>Older</button></div>
    </section>
  </div>;
}
