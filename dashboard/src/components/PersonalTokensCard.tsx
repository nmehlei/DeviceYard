"use client";
import { useEffect, useState, type FormEvent } from "react";
import { fetchMyTokens, createMyToken, revokeMyToken, ApiError, type UserToken } from "../lib/api";
import { PlusIcon, TrashIcon, EyeIcon, EyeOffIcon, CopyIcon } from "./icons";
import { ActionDialog, DialogActions } from "./ActionDialog";

function formatLastUsed(lastUsedAt: number | null): string {
  return lastUsedAt === null ? "never" : new Date(lastUsedAt).toLocaleString();
}

/** Mirrors OrgTokensCard.tsx (masking, Show/Hide, label + create) with three
 * differences the personal-token semantics require: it hits /api/me/tokens
 * instead of an org-scoped endpoint, it shows a lastUsedAt column (the thing
 * an owner reads before deciding a token is safe to revoke), and revoke goes
 * through an inline confirmation naming the label instead of firing
 * immediately - a personal token can be in use on a machine nobody in this
 * tab can see, so a silent revoke is a foot-gun the org-scoped card doesn't
 * have to guard against as carefully.
 *
 * `open` gates the fetch (I5): this card is mounted unconditionally inside
 * AccountDialog (which itself always renders, visibility being just the
 * native <dialog>'s open/closed state), so an unconditional useEffect(reload,
 * []) issued GET /api/me/tokens - which returns every PAT decrypted - on
 * every dashboard page load, not just when a person actually opens Account
 * settings. Only fetch once the dialog is actually open. */
export default function PersonalTokensCard({ open }: { open: boolean }) {
  const [creating, setCreating] = useState(false);
  const [tokens, setTokens] = useState<UserToken[] | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [pendingRevokeId, setPendingRevokeId] = useState<number | undefined>(undefined);
  const [copiedId, setCopiedId] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    fetchMyTokens()
      .then((t) => {
        setTokens(t);
        setLoadError(undefined);
      })
      // Previously swallowed into an empty list, which then rendered the
      // "what a PAT is for" empty state as though the person genuinely had
      // no tokens - indistinguishable from a real fetch failure. Now that
      // this fires every time the dialog opens (not just once per page
      // load), that silent misdirection is worth avoiding.
      .catch((err) => {
        setTokens([]);
        setLoadError(err instanceof ApiError ? err.message : "failed to load personal tokens");
      });
  };

  useEffect(() => {
    if (open) reload();
  }, [open]);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setError("label is required");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const token = await createMyToken(label.trim());
      setLabel("");
      setCreating(false);
      // Show it revealed immediately: the person just made it and needs to
      // copy it, not hunt for a Show button on the row they just created.
      setRevealed((prev) => new Set(prev).add(token.id));
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to create token");
    } finally {
      setBusy(false);
    }
  };

  const onConfirmRevoke = async (tokenId: number) => {
    setBusy(true);
    setError(undefined);
    try {
      await revokeMyToken(tokenId);
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

  // Silence either way (works vs. unavailable) leaves the person unable to
  // tell whether the click landed before they paste a token somewhere -
  // "Copied" on success and a visible error on failure both use state the
  // card already has, rather than adding a toast library for one button.
  const onCopy = async (tokenId: number, value: string) => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      setError(undefined);
      setCopiedId(tokenId);
      setTimeout(() => setCopiedId((current) => (current === tokenId ? undefined : current)), 1500);
    } catch {
      setError("failed to copy token to clipboard");
    }
  };

  return (
    <div className="ui-card settings-data-card"><div className="settings-box-head"><div><h2>Personal access tokens</h2><p className="text-xs text-(--muted)">For your CLI and agent connections.</p></div><button className="ui-button" onClick={() => { setError(undefined); setCreating(true); }}><PlusIcon />Create token</button></div>


      {tokens === undefined ? (
        <p className="text-xs text-(--muted)">Loading…</p>
      ) : loadError ? (
        <p className="mb-3 text-xs text-(--status-failed)">{loadError}</p>
      ) : tokens.length === 0 ? (
        <p className="mb-3 text-xs text-(--muted)">
          A personal access token lets the MCP client act as you across every org you belong to — one credential
          instead of one per org.
        </p>
      ) : (
        <ul className="mb-3 flex flex-col gap-1 text-sm">
          {tokens.map((t) => (
            <li key={t.id} className="flex flex-col gap-1 border-t border-(--border) py-2 first:border-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-(--foreground)">{t.label}</span>
                <span className="text-xs text-(--muted)">last used: {formatLastUsed(t.lastUsedAt)}</span>
              </div>
              <div className="mono flex items-center gap-2 text-xs text-(--muted)">
                <span className="flex-1 truncate">{revealed.has(t.id) ? t.value : "•".repeat(12)}</span>
                <button onClick={() => toggleReveal(t.id)} className="flex items-center gap-1 text-(--status-running)">
                  {revealed.has(t.id) ? <EyeOffIcon /> : <EyeIcon />}
                  {revealed.has(t.id) ? "Hide" : "Show"}
                </button>
                <button onClick={() => onCopy(t.id, t.value)} className="flex items-center gap-1 text-(--foreground)">
                  <CopyIcon />
                  {copiedId === t.id ? "Copied" : "Copy"}
                </button>
                  <button
                    onClick={() => { setError(undefined); setPendingRevokeId(t.id); }}
                    disabled={busy}
                    className="flex items-center gap-1 text-(--status-failed)"
                  >
                    <TrashIcon />
                    Revoke
                  </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && !creating && pendingRevokeId === undefined && <p role="alert" className="ui-error">{error}</p>}


      <ActionDialog open={creating} onClose={() => { setCreating(false); setLabel(""); }} busy={busy} title="Create personal token" description="Choose a name that identifies where this token will be used.">
      <form onSubmit={onCreate}>
        <label className="ui-label" htmlFor="personal-token-label">Token label</label>
        <input
          id="personal-token-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. laptop"
          aria-label="Label"
          className="flex-1 rounded-md border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
        />
        {error && <p role="alert" className="ui-error">{error}</p>}
        <DialogActions onClose={() => { setCreating(false); setLabel(""); }} busy={busy} label="Create token" />
      </form>
      </ActionDialog>
      <ActionDialog open={pendingRevokeId !== undefined} onClose={() => setPendingRevokeId(undefined)} busy={busy} danger title="Revoke token" target={tokens?.find(t => t.id === pendingRevokeId)?.label} description="Integrations using this token will lose access. This cannot be undone.">
        {error && <p role="alert" className="ui-error">{error}</p>}
        <DialogActions onClose={() => setPendingRevokeId(undefined)} busy={busy} danger label="Revoke token" onConfirm={() => { if (pendingRevokeId !== undefined) void onConfirmRevoke(pendingRevokeId); }} />
      </ActionDialog>
    </div>
  );
}
