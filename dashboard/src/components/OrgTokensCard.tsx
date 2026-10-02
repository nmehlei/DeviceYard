"use client";
import { useEffect, useState, type FormEvent } from "react";
import { fetchOrgTokens, createOrgToken, revokeOrgToken, ApiError, type OrgToken } from "../lib/api";
import { PlusIcon, TrashIcon, EyeIcon, EyeOffIcon } from "./icons";
import { ActionDialog, DialogActions } from "./ActionDialog";

export function OrgTokensCard({ orgId }: { orgId: number }) {
  const [creating, setCreating] = useState(false);
  const [pendingRevokeId, setPendingRevokeId] = useState<number>();
  const [tokens, setTokens] = useState<OrgToken[] | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    fetchOrgTokens(orgId)
      .then(setTokens)
      .catch(() => setTokens([]));
  };

  useEffect(reload, [orgId]);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setError("label is required");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await createOrgToken(orgId, label.trim());
      setLabel("");
      setCreating(false);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to create token");
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (tokenId: number) => {
    setBusy(true);
    setError(undefined);
    try {
      await revokeOrgToken(orgId, tokenId);
      setPendingRevokeId(undefined);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to revoke token");
    } finally {
      setBusy(false);
    }
  };

  const toggleReveal = (tokenId: number) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId);
      else next.add(tokenId);
      return next;
    });
  };

  return (
    <div className="ui-card settings-data-card"><div className="settings-box-head"><div><h2>Organization tokens</h2><p className="text-xs text-(--muted)">Credentials scoped to this organization.</p></div><button className="ui-button" onClick={() => { setError(undefined); setCreating(true); }}><PlusIcon />New token</button></div>


      {tokens === undefined ? (
        <p className="text-xs text-(--muted)">Loading…</p>
      ) : (
        <ul className="mb-3 flex flex-col gap-1 text-sm">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 border-t border-(--border) py-2 first:border-0">
              <span className="text-(--foreground)">{t.label}</span>
              <span className="mono flex items-center gap-2 text-xs text-(--muted)">
                {revealed.has(t.id) ? t.value : "•".repeat(12)}
                <button onClick={() => toggleReveal(t.id)} className="flex items-center gap-1 text-(--status-running)">
                  {revealed.has(t.id) ? <EyeOffIcon /> : <EyeIcon />}
                  {revealed.has(t.id) ? "Hide" : "Show"}
                </button>
                <button
                  onClick={() => { setError(undefined); setPendingRevokeId(t.id); }}
                  disabled={busy}
                  className="flex items-center gap-1 text-(--status-failed)"
                >
                  <TrashIcon />
                  Revoke
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && !creating && pendingRevokeId === undefined && <p role="alert" className="ui-error">{error}</p>}


      <ActionDialog open={creating} onClose={() => { setCreating(false); setLabel(""); }} busy={busy} title="Create organization token" description="Choose a name that identifies where this token will be used.">
      <form onSubmit={onCreate}>
        <label className="ui-label" htmlFor="org-token-label">Token label</label>
        <input
          id="org-token-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. CI"
          className="flex-1 rounded-md border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
        />
        {error && <p role="alert" className="ui-error">{error}</p>}
        <DialogActions onClose={() => { setCreating(false); setLabel(""); }} busy={busy} label="Create token" />
      </form>
      </ActionDialog>
      <ActionDialog open={pendingRevokeId !== undefined} onClose={() => setPendingRevokeId(undefined)} busy={busy} danger title="Revoke token" target={tokens?.find(t => t.id === pendingRevokeId)?.label} description="Integrations using this token will lose access. This cannot be undone.">
        {error && <p role="alert" className="ui-error">{error}</p>}
        <DialogActions onClose={() => setPendingRevokeId(undefined)} busy={busy} danger label="Revoke token" onConfirm={() => { if (pendingRevokeId !== undefined) void onRevoke(pendingRevokeId); }} />
      </ActionDialog>
    </div>
  );
}
