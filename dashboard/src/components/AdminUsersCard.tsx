"use client";
import { useEffect, useState, type FormEvent } from "react";
import { adminListUsers, adminCreateUser, adminEditUser, adminDeactivateUser, ApiError, type User } from "../lib/api";
import { PlusIcon, ShieldIcon, TrashIcon, KeyIcon } from "./icons";

import { ActionDialog, DialogActions } from "./ActionDialog";

const MIN_PASSWORD_LENGTH = 8;

export function AdminUsersCard() {
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<{ kind: "reset" | "admin" | "deactivate"; user: User }>();
  const close = () => { setAction(undefined); setResetDrafts({}); setError(undefined); };
  const [users, setUsers] = useState<User[] | undefined>(undefined);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Per-user draft value for the inline password-reset input - keyed by
  // user id so each row's field is independent.
  const [resetDrafts, setResetDrafts] = useState<Record<number, string>>({});

  const reload = () => {
    adminListUsers()
      .then(setUsers)
      .catch(() => setUsers([]));
  };
  useEffect(reload, []);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !email.trim() || password.length < 8) {
      setError("username, email, and an 8+ character password are required");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await adminCreateUser(username.trim(), email.trim(), password);
      setUsername("");
      setEmail("");
      setPassword(""); setCreating(false);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to create user");
    } finally {
      setBusy(false);
    }
  };

  const onToggleAdmin = async (user: User) => {
    setBusy(true);
    setError(undefined);
    try {
      await adminEditUser(user.id, { isAdmin: !user.isAdmin }); close();
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to edit user");
    } finally {
      setBusy(false);
    }
  };

  const onDeactivate = async (id: number) => {
    setBusy(true);
    setError(undefined);
    try {
      await adminDeactivateUser(id); close();
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to deactivate user");
    } finally {
      setBusy(false);
    }
  };

  const onResetPassword = async (id: number) => {
    const draft = resetDrafts[id] ?? "";
    if (draft.length < MIN_PASSWORD_LENGTH) {
      setError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await adminEditUser(id, { password: draft }); close();
      setResetDrafts((prev) => ({ ...prev, [id]: "" }));
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to reset password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-card settings-data-card"><div className="settings-box-head"><div><h2>Users</h2><p className="text-xs text-(--muted)">Manage accounts and administrator access.</p></div><button className="ui-button" onClick={() => { setError(undefined); setCreating(true); }}><PlusIcon />Create user</button></div>
      {users === undefined ? (
        <p className="text-xs text-(--muted)">Loading…</p>
      ) : (
        <ul className="mb-3 flex flex-col gap-1 text-sm">
          {users.map((u) => (
            <li key={u.id} className="flex flex-col gap-2 border-t border-(--border) py-2 first:border-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-(--foreground)">
                  {u.username} <span className="text-(--muted)">({u.email})</span>
                  {u.isAdmin && <span className="ml-2 text-xs text-(--status-running)">admin</span>}
                </span>
                <span className="flex gap-2 text-xs">
                  <button onClick={() => { setError(undefined); setAction({ kind: "admin", user: u }); }} disabled={busy} className="flex items-center gap-1 text-(--foreground)">
                    <ShieldIcon />
                    {u.isAdmin ? "Revoke admin" : "Make admin"}
                  </button>
                  <button
                    onClick={() => { setError(undefined); setAction({ kind: "deactivate", user: u }); }}
                    disabled={busy}
                    className="flex items-center gap-1 text-(--status-failed)"
                  >
                    <TrashIcon />
                    Deactivate
                  </button>
                </span>
              </div>
              <button className="ui-button" onClick={() => { setError(undefined); setAction({ kind: "reset", user: u }); }}><KeyIcon />Reset password</button>
            </li>
          ))}
        </ul>
      )}




      <ActionDialog open={creating} onClose={() => { setCreating(false); setPassword(""); }} busy={busy} title="Create user"><form onSubmit={onCreate} className="flex flex-col gap-2">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username" aria-label="Username"
          className="rounded-md border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email" aria-label="Email" type="email"
          className="rounded-md border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder="temporary password" aria-label="Temporary password" autoComplete="new-password"
          className="rounded-md border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
        />
        {error && <p role="alert" className="ui-error">{error}</p>}<DialogActions onClose={() => { setCreating(false); setPassword(""); }} busy={busy} label="Create user" />
      </form></ActionDialog>
      <ActionDialog open={!!action} onClose={close} busy={busy} danger={action?.kind !== "reset"} title={action?.kind === "reset" ? "Reset password" : action?.kind === "admin" ? (action.user.isAdmin ? "Revoke administrator access" : "Grant administrator access") : "Deactivate user"} target={action?.user.username} description={action?.kind === "admin" ? "Administrator access applies across the entire farm." : action?.kind === "deactivate" ? "This account will no longer be able to sign in." : "Choose a new password of at least 8 characters."}>
        {action?.kind === "reset" && <label className="ui-label">New password<input type="password" autoComplete="new-password" aria-label={`new password for ${action.user.username}`} value={resetDrafts[action.user.id] ?? ""} onChange={e => setResetDrafts({ [action.user.id]: e.target.value })} /></label>}
        {error && <p role="alert" className="ui-error">{error}</p>}
        <DialogActions onClose={close} busy={busy} danger={action?.kind !== "reset"} label={action?.kind === "reset" ? "Reset password" : action?.kind === "admin" ? (action.user.isAdmin ? "Revoke admin" : "Make admin") : "Deactivate user"} onConfirm={() => { if (action) void (action.kind === "reset" ? onResetPassword(action.user.id) : action.kind === "admin" ? onToggleAdmin(action.user) : onDeactivate(action.user.id)); }} />
      </ActionDialog>
    </div>
  );
}
