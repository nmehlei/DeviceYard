"use client";
import { useState, type FormEvent } from "react";
import { changePassword, ApiError } from "../lib/api";

import { ActionDialog, DialogActions } from "./ActionDialog";
import { KeyIcon } from "./icons";

const MIN_PASSWORD_LENGTH = 8;

export function ChangePasswordCard() {
  const [open, setOpen] = useState(false);
  const close = () => { setOpen(false); setCurrentPassword(""); setNewPassword(""); setError(undefined); };
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSuccess(false);
    if (!currentPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`current password and a new password of at least ${MIN_PASSWORD_LENGTH} characters are required`);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setSuccess(true); setOpen(false);
    } catch (err) {
      // ApiError carries the server's specific message ("current password is
      // incorrect", the length requirement) - surfaced as-is, not flattened
      // into one generic failure, same as every other form in this dashboard.
      setError(err instanceof ApiError ? err.message : "failed to change password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-card">
      <h2>Password</h2><p className="mb-4 text-xs text-(--muted)">Update the password used to sign in.</p>

      <button className="ui-button" onClick={() => setOpen(true)}><KeyIcon />Change password</button>
      {success && <p role="status" className="ui-success">Password changed.</p>}
      <ActionDialog open={open} onClose={close} busy={busy} title="Change password" description="Keep this account secure.">
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <label className="ui-label" htmlFor="current-password">Current password</label>
        <input
          id="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          type="password"
          placeholder="current password"
          aria-label="current password"
          className="rounded-md border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
        />
        <label className="ui-label" htmlFor="new-password">New password</label>
        <input
          id="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          type="password"
          placeholder="new password"
          aria-label="new password"
          className="rounded-md border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
        />

        {error && <p className="text-xs text-(--status-failed)">{error}</p>}

        <DialogActions onClose={close} busy={busy} label="Change password" />
      </form>
      </ActionDialog>
    </div>
  );
}
