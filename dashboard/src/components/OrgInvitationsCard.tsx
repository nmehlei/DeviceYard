"use client";
import { useEffect, useState } from "react";
import { ActionDialog, DialogActions } from "./ActionDialog";
import { PlusIcon, TrashIcon } from "./icons";
import { notificationRequest, type Invitation } from "../lib/notifications";
export function OrgInvitationsCard({ orgId }: { orgId: number }) {
  const [inviting, setInviting] = useState(false); const [revoking, setRevoking] = useState<Invitation>();
  const close = () => { setInviting(false); setRevoking(undefined); setEmail(""); setError(""); };
  const [items, setItems] = useState<Invitation[]>([]); const [email, setEmail] = useState(""); const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    notificationRequest<{ invitations: Invitation[] }>(`/api/orgs/${orgId}/invitations`).then((result) => { if (!cancelled) setItems(result.invitations); }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [orgId]);
  async function act(path: string, body?: unknown, method?: string) {
    setBusy(true); setError(""); setMessage("");
    try { await notificationRequest(path, body, method); const result = await notificationRequest<{ invitations: Invitation[] }>(`/api/orgs/${orgId}/invitations`); setItems(result.invitations); close(); setMessage(method === "DELETE" ? "Invitation revoked." : "Invitation email queued."); }
    catch (e) { setError(e instanceof Error ? e.message : "Invitation could not be updated."); } finally { setBusy(false); }
  }
  return <section className="mt-6 border-t border-(--border) pt-5"><h3 className="mb-2 font-medium">Invite someone new</h3><p className="mb-4 text-xs text-(--muted)">Send an invitation by email. They can join with an existing account or create one.</p>
    {error && !inviting && !revoking && <p role="alert" className="notify-error mb-3">{error}</p>}{message && <p role="status" className="notify-success mb-3">{message}</p>}
    <button className="ui-button" onClick={() => { setError(""); setInviting(true); }}><PlusIcon />Invite by email</button>
    <ActionDialog open={inviting} onClose={close} title="Invite by email" description="Send an invitation to join this organization." busy={busy}><form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void act(`/api/orgs/${orgId}/invitations`, { email }); }}><label className="min-w-0 flex-1 text-xs">Email address<input className="notify-input mt-2" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>{error && <p role="alert" className="ui-error">{error}</p>}<DialogActions onClose={close} busy={busy} label="Send invitation" /></form></ActionDialog>
    <ul className="mt-4">{items.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-(--border) py-3 text-sm"><span className="break-all">{item.email}<span className="ml-2 notify-tag">{item.status}</span></span><span className="flex gap-2">{["pending", "expired"].includes(item.status) && <button className="notify-chip" disabled={busy} onClick={() => act(`/api/orgs/${orgId}/invitations/${item.id}/resend`, {})}>Resend</button>}{item.status === "pending" && <button className="notify-chip" disabled={busy} onClick={() => { setError(""); setRevoking(item); }}><TrashIcon />Revoke</button>}</span></li>)}</ul>
    <ActionDialog open={!!revoking} onClose={close} title="Revoke invitation" target={revoking?.email} danger busy={busy}><p className="ui-muted">This invitation link will no longer allow access to the organization.</p>{error && <p role="alert" className="ui-error">{error}</p>}<DialogActions onClose={close} busy={busy} label="Revoke invitation" danger onConfirm={() => { if (revoking) void act(`/api/orgs/${orgId}/invitations/${revoking.id}`, undefined, "DELETE"); }} /></ActionDialog>
  </section>;
}
