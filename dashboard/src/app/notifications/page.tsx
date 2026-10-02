"use client";
import { useEffect, useState } from "react";
import { useRequireSession } from "../../lib/useRequireSession";
import { notificationRequest, type Preferences, type RunPreference } from "../../lib/notifications";
import { SettingsLayout } from "../../components/SettingsLayout";
import { EmailPreview } from "../../components/EmailPreview";

export default function NotificationsPage() {
  const session = useRequireSession();
  const [saved, setSaved] = useState<Preferences>(); const [draft, setDraft] = useState<Preferences>();
  const [selected, setSelected] = useState(0); const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  useEffect(() => {
    if (session !== "ok") return;
    let cancelled = false;
    notificationRequest<Preferences>("/api/me/notifications").then((data) => { if (!cancelled) { setSaved(data); setDraft(data); } }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [session]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    const click = (e: MouseEvent) => { if ((e.target as HTMLElement).closest("a[href]") && !window.confirm("Discard your unsaved notification changes?")) { e.preventDefault(); e.stopPropagation(); } };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", click, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", click, true); };
  }, [dirty]);
  async function save() {
    if (!draft) return; setBusy(true); setError(""); setMessage("");
    try { const data = await notificationRequest<Preferences>("/api/me/notifications", { orgs: draft.orgs, deviceHealth: draft.deviceHealth }, "PUT"); setSaved(data); setDraft(data); setMessage("Your notification preferences are saved."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save preferences."); } finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true); setError("");
    try { await notificationRequest("/api/account/verify-email", {}); setMessage("Verification email requested. Check your inbox, then reload this page."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not request verification."); } finally { setBusy(false); }
  }
  const org = draft?.orgs[selected];
  return <SettingsLayout scope="Personal settings" title="Notifications" description="Choose which updates reach you and where they arrive." links={[{ label: "Account", href: "/account", active: false }, { label: "Notifications", href: "/notifications", active: true }]}>
    {error && <p role="alert" className="notify-error mb-5">{error}</p>}{message && <p role="status" className="notify-success mb-5">{message}</p>}
    {!draft ? <div role="status" className="notify-card">{error ? <button className="notify-button" onClick={() => window.location.reload()}>Try again</button> : "Loading your preferences…"}</div> : <>
      <div className="notification-columns"><div className="space-y-5">
        <section className="notify-card"><div className="settings-box-head"><h2>Email delivery</h2><span className="text-xs text-(--status-passed)">{draft.verified ? "✓ Verified" : "Verification needed"}</span></div><p className="break-all">{draft.email || "No email address"}</p>{draft.verified && <p className="mt-2 text-xs text-(--muted)">Your address is ready to receive updates.</p>}
          {!draft.available && <p className="mt-4 text-sm text-(--muted)">Email is not configured yet. Ask an administrator to set up SMTP.</p>}
          {!draft.verified && <><p className="my-4 text-sm text-(--muted)">Confirm this address before turning on optional updates.</p><button className="notify-button" disabled={busy || !draft.available} onClick={verify}>Send verification email</button></>}
        </section>
        <section className="notify-card">
          {!draft.orgs.length ? <p className="text-sm text-(--muted)">Join an organisation to choose its run notifications.</p> : <>
            <label className="block text-sm">Organisation<select className="notify-input my-3" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>{draft.orgs.map((o, index) => <option key={o.orgId} value={index}>{o.orgName}</option>)}</select></label>
            <fieldset disabled={busy}><legend className="mb-3 font-medium">Run updates</legend>{([["off", "Off", "Check results in the dashboard."], ["failures", "Failures only", "Failed flows and jobs that could not finish."], ["all", "Every completed run", "A summary for every success and failure."]] as const).map(([value, title, detail]) => <label key={value} className={`notify-choice ${org?.run === value ? "notify-choice-selected" : ""}`}><input type="radio" name="run-frequency" value={value} checked={org?.run === value} disabled={value !== "off" && (!draft.available || !draft.verified)} onChange={() => { setMessage(""); setDraft({ ...draft, orgs: draft.orgs.map((o, i) => i === selected ? { ...o, run: value as RunPreference } : o) }); }} /><span><span className="block font-medium">{title}</span><span className="mt-1 block text-sm text-(--muted)">{detail}</span></span></label>)}</fieldset>
          </>}
        {draft.isAdmin && <div className={`notification-health ${draft.deviceHealth ? "notification-health-selected" : ""}`}><label className="flex gap-3"><input type="checkbox" checked={draft.deviceHealth} disabled={busy || (!draft.deviceHealth && (!draft.available || !draft.verified))} onChange={(e) => setDraft({ ...draft, deviceHealth: e.target.checked })} /><span><strong className="block">Device health alerts</strong><span className="mt-2 block text-sm text-(--muted)">An email after two minutes offline, followed by a recovery update. Brief disconnects stay quiet.</span></span></label></div>}
        <div className="mt-5 flex items-center gap-4"><button className="notify-button" disabled={!dirty || busy} onClick={save}>{busy ? "Working…" : "Save preferences"}</button>{dirty && <span className="text-sm text-(--muted)">Unsaved changes</span>}</div>
        </section><p className="text-xs text-(--muted)">Invitations, verification, and password reset emails are sent when requested, independently of these preferences.</p>
      </div><EmailPreview /></div>
      <section className="settings-future" aria-label="Future notification channels"><h3>More ways to stay updated</h3><p className="text-xs text-(--muted)">Additional notification channels are planned.</p><div className="future-channels mt-3">{["Slack", "Push", "Webhooks"].map(name => <span key={name}>{name} <small>Coming later</small></span>)}</div></section>
    </>}
  </SettingsLayout>;
}
