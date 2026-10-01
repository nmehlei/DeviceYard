"use client";
import { useEffect, useState, type FormEvent } from "react";
import { adminListOrgs, adminCreateOrg, adminRenameOrg, adminArchiveOrg, ApiError, type Org } from "../lib/api";
import { PlusIcon, PencilIcon, ArchiveIcon } from "./icons";

import { ActionDialog, DialogActions } from "./ActionDialog";

export function AdminOrgsCard() {
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<Org>();
  const [orgs, setOrgs] = useState<Org[] | undefined>(undefined);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: number; name: string } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    adminListOrgs()
      .then(setOrgs)
      .catch(() => setOrgs([]));
  };
  useEffect(reload, []);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("name is required");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await adminCreateOrg(name.trim());
      setName(""); setCreating(false);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to create org");
    } finally {
      setBusy(false);
    }
  };

  const onRename = async () => {
    if (!renaming) return;
    setBusy(true);
    setError(undefined);
    try {
      await adminRenameOrg(renaming.id, renaming.name);
      setRenaming(undefined);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to rename org");
    } finally {
      setBusy(false);
    }
  };

  const onArchive = async (id: number) => {
    setBusy(true);
    setError(undefined);
    try {
      await adminArchiveOrg(id); setArchiving(undefined);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to archive org");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-card settings-data-card"><div className="settings-box-head"><div><h2>Organizations</h2><p className="text-xs text-(--muted)">Manage the organizations on this farm.</p></div><button className="ui-button" onClick={() => { setError(undefined); setCreating(true); }}><PlusIcon />Create org</button></div>
      {orgs === undefined ? (
        <p className="text-xs text-(--muted)">Loading…</p>
      ) : (
        <ul className="mb-3 flex flex-col gap-1 text-sm">
          {orgs.map((org) => (
            <li key={org.id} className="flex items-center justify-between gap-2 border-t border-(--border) py-2 first:border-0">
              <span className="text-(--foreground)">
                  {org.name}
                  {org.archivedAt !== null && <span className="ml-2 text-xs text-(--muted)">archived</span>}
                </span>
              <span className="flex gap-2 text-xs">
                <button
                    onClick={() => { setError(undefined); setRenaming({ id: org.id, name: org.name }); }}
                    className="flex items-center gap-1 text-(--foreground)"
                  >
                    <PencilIcon />
                    Rename
                  </button>
                {org.archivedAt === null && (
                  <button
                    onClick={() => { setError(undefined); setArchiving(org); }}
                    disabled={busy}
                    className="flex items-center gap-1 text-(--status-failed)"
                  >
                    <ArchiveIcon />
                    Archive
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}




      <ActionDialog open={creating} onClose={() => { setCreating(false); setName(""); }} busy={busy} title="Create organization"><form onSubmit={onCreate}><label className="ui-label" htmlFor="new-org-name">Organization name</label>
        <input
          id="new-org-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new org name"
          className="flex-1 rounded-md border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
        />
        {error && <p role="alert" className="ui-error">{error}</p>}<DialogActions onClose={() => setCreating(false)} busy={busy} label="Create organization" />
      </form></ActionDialog>
      <ActionDialog open={!!renaming} onClose={() => setRenaming(undefined)} busy={busy} title="Rename organization">
        <form onSubmit={e => { e.preventDefault(); void onRename(); }}><label className="ui-label" htmlFor="rename-org">Organization name</label><input id="rename-org" required value={renaming?.name ?? ""} onChange={e => { if (renaming) setRenaming({ ...renaming, name: e.target.value }); }} />
        {error && <p role="alert" className="ui-error">{error}</p>}<DialogActions onClose={() => setRenaming(undefined)} busy={busy} label="Save name" /></form>
      </ActionDialog>
      <ActionDialog open={!!archiving} onClose={() => setArchiving(undefined)} busy={busy} danger title="Archive organization" target={archiving?.name} description="Archive this organization and prevent new jobs from being submitted.">
        {error && <p role="alert" className="ui-error">{error}</p>}<DialogActions onClose={() => setArchiving(undefined)} busy={busy} danger label="Archive organization" onConfirm={() => { if (archiving) void onArchive(archiving.id); }} />
      </ActionDialog>
    </div>
  );
}
