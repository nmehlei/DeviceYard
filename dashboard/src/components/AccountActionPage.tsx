"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { notificationRequest } from "../lib/notifications";
import { login, logout, fetchSession } from "../lib/api";

type Kind = "invitation" | "password-reset" | "email-verification";
export function AccountActionPage({ kind }: { kind: Kind }) {
  const capturedToken = useRef<string | null>(null);
  const [token, setToken] = useState(""); const [loaded, setLoaded] = useState(false);
  const [info, setInfo] = useState<{ kind: Kind; existingAccount: boolean; organisationName?: string }>();
  const [email, setEmail] = useState(""); const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [signedIn, setSignedIn] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false); const [complete, setComplete] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (capturedToken.current === null) capturedToken.current = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    const value = capturedToken.current;
    window.history.replaceState(null, "", window.location.pathname);
    // Tokens stay only in this page's memory after loading; never local storage.
    Promise.resolve().then(() => { if (!cancelled) setToken(value); });
    if (!value) { Promise.resolve().then(() => { if (!cancelled) setLoaded(true); }); return () => { cancelled = true; }; }
    Promise.all([notificationRequest<{ kind: Kind; existingAccount: boolean; organisationName?: string }>("/api/account/actions/inspect", { token: value }), fetchSession().catch(() => undefined)])
      .then(([result, session]) => { if (cancelled) return; if (result.kind !== kind) throw new Error("This link is for a different account action."); setInfo(result); setSignedIn(!!session); })
      .catch((e) => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [kind]);
  const title = kind === "invitation" ? "A place on the team" : kind === "password-reset" ? "Let’s get you back in" : "Make it official";
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      if (!token && kind === "password-reset") {
        const result = await notificationRequest<{ message: string }>("/api/account/password-reset", { email }); setMessage(result.message); return;
      }
      if (kind === "invitation" && info?.existingAccount && !signedIn) { await login(username, password); setSignedIn(true); }
      await notificationRequest("/api/account/actions/redeem", { token, kind, username, password });
      capturedToken.current = ""; setToken(""); setPassword(""); setComplete(true);
      setMessage(kind === "invitation" ? "You’re in. Your organisation is ready to explore." : kind === "password-reset" ? "Password updated. Sign in with your new password." : "Email verified. You can now choose your notifications.");
    } catch (e) { setError(e instanceof Error ? e.message : "This action could not be completed."); } finally { setBusy(false); }
  }
  const needsCredentials = kind === "invitation" && (!info?.existingAccount || !signedIn);
  return <main className="notify-page flex min-h-[80vh] items-center justify-center"><section className="notify-card w-full max-w-lg">
    <p className="notify-eyebrow">DeviceYard · {kind.replaceAll("-", " ")}</p><h1 className="mb-4 text-3xl font-semibold tracking-tight">{title}</h1>
    {error && <p role="alert" className="notify-error mb-5">{error}</p>}{message && <p role="status" className="notify-success mb-5">{message}</p>}
    {!loaded ? <p role="status">Checking your link…</p> : complete ? <Link className="notify-button inline-block" href={kind === "email-verification" ? "/notifications" : "/login"}>{kind === "email-verification" ? "Choose notifications" : "Continue to sign in"}</Link> :
      !token && kind !== "password-reset" ? <p className="text-(--muted)">Open the link from your email to continue.</p> : (token && !info) ? <p className="text-(--muted)">Request a new email or contact your administrator.</p> : <form onSubmit={submit} className="space-y-5">
        {kind === "invitation" && <p className="text-(--muted)">Join <strong className="text-(--foreground)">{info?.organisationName}</strong>. {info?.existingAccount ? "Sign in with the invited account to accept." : "Create your account to get started."}</p>}
        {kind === "invitation" && signedIn && <button type="button" className="notify-chip" disabled={busy} onClick={async () => {
          setBusy(true); try { await logout(); setSignedIn(false); setPassword(""); setError(""); } catch { setError("Could not sign out. Please try again."); } finally { setBusy(false); }
        }}>Use a different account</button>}
        {!token ? <><p className="text-sm text-(--muted)">Enter your account email and we’ll send a password reset link.</p><label className="block text-sm">Email address<input className="notify-input mt-2" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label></> : <>
          {needsCredentials && <label className="block text-sm">Username<input className="notify-input mt-2" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} /></label>}
          {(kind === "password-reset" || needsCredentials) && <label className="block text-sm">{info?.existingAccount && kind === "invitation" ? "Password" : "New password"}<input className="notify-input mt-2" type="password" autoComplete={info?.existingAccount && kind === "invitation" ? "current-password" : "new-password"} minLength={8} maxLength={1024} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>}
          {kind === "password-reset" && <p className="text-xs leading-6 text-(--muted)">Use at least 8 characters. Resetting signs out all existing sessions and revokes your personal access tokens.</p>}
          {kind === "email-verification" && <p className="text-(--muted)">Confirm that this email address belongs to you. Nothing is changed until you click below.</p>}
        </>}
        <button className="notify-button w-full" disabled={busy}>{busy ? "Working…" : !token ? "Send reset link" : kind === "invitation" ? "Accept invitation" : kind === "password-reset" ? "Reset password" : "Verify email"}</button>
        <Link href="/login" className="block text-center text-sm text-(--muted)">Back to sign in</Link>
      </form>}
  </section></main>;
}
