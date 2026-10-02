"use client";
import { useEffect, useState, type FormEvent } from "react";
import { fetchOrgMembers, addOrgMember, removeOrgMember, ApiError, type User } from "../lib/api";
import { PlusIcon, TrashIcon } from "./icons";
import { OrgInvitationsCard } from "./OrgInvitationsCard";

import { ActionDialog, DialogActions } from "./ActionDialog";

export function OrgMembersCard({ orgId }: { orgId: number }) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<User>();
  const [members, setMembers] = useState<User[] | undefined>(undefined);
  const [newUserId, setNewUserId] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    fetchOrgMembers(orgId)
      .then(setMembers)
      .catch(() => setMembers([]));
  };

  useEffect(reload, [orgId]);

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    const userId = Number(newUserId);
    if (!Number.isInteger(userId)) {
      setError("enter a numeric user id");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await addOrgMember(orgId, userId);
      setNewUserId(""); setAdding(false);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to add member");
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (userId: number) => {
    setBusy(true);
    setError(undefined);
    try {
      await removeOrgMember(orgId, userId); setRemoving(undefined);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to remove member");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-card settings-data-card"><div className="settings-box-head"><div><h2>Members</h2><p className="text-xs text-(--muted)">People with access to this organization.</p></div><button className="ui-button" onClick={() => { setError(undefined); setAdding(true); }}><PlusIcon />Add member</button></div>


      {members === undefined ? (
        <p className="text-xs text-(--muted)">Loading…</p>
      ) : (
        <ul className="mb-3 flex flex-col gap-1 text-sm">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between border-t border-(--border) py-2 first:border-0">
              <span className="text-(--foreground)">
                {m.username} <span className="text-(--muted)">({m.email})</span>
              </span>
              <button
                onClick={() => { setError(undefined); setRemoving(m); }}
                disabled={busy}
                className="flex items-center gap-1 text-xs text-(--status-failed)"
              >
                <TrashIcon />
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}




      <ActionDialog open={adding} onClose={() => setAdding(false)} busy={busy} title="Add existing user"><form onSubmit={onAdd}><label className="ui-label" htmlFor="member-id">User ID</label>
        <input
          id="member-id"
          value={newUserId}
          onChange={(e) => setNewUserId(e.target.value)}
          placeholder="user id"
          className="w-24 rounded-md border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
        />
        {error && <p role="alert" className="ui-error">{error}</p>}<DialogActions onClose={() => setAdding(false)} busy={busy} label="Add member" />
      </form></ActionDialog>
      <ActionDialog open={!!removing} onClose={() => setRemoving(undefined)} busy={busy} danger title="Remove member" target={removing?.username} description="This person will lose access to this organization.">
        {error && <p role="alert" className="ui-error">{error}</p>}<DialogActions onClose={() => setRemoving(undefined)} busy={busy} danger label="Remove member" onConfirm={() => { if (removing) void onRemove(removing.id); }} />
      </ActionDialog>
      <p className="mt-2 text-xs text-(--muted)">
        Picks from an existing account by id - admins create new accounts under Admin → Users.
      </p>
      <OrgInvitationsCard orgId={orgId} />
    </div>
  );
}
