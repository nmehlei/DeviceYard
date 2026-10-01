"use client";
import { useEffect, useState, type FormEvent } from "react";
import { fetchUploadSettings, updateUploadSettings, ApiError, type UploadSettings } from "../lib/api";

const BYTES_PER_MB = 1024 * 1024;

/** The field is in MB because that is the unit an operator thinks in when
 * looking at an APK; the API stores bytes. Kept as a string while editing so
 * the box can sit empty mid-typing without being coerced to 0 - empty means
 * "no limit" (null) on save, matching the API's contract. */
function toField(settings: UploadSettings): string {
  return settings.maxUploadBytes === null ? "" : String(settings.maxUploadBytes / BYTES_PER_MB);
}

/** Returns bytes, `null` for an empty (no-limit) field, or `undefined` as the
 * invalid sentinel - the same three-way parse the server does. */
function parseField(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  const mb = Number(value);
  if (!Number.isFinite(mb) || mb <= 0) return undefined;
  const bytes = Math.round(mb * BYTES_PER_MB);
  return bytes > 0 ? bytes : undefined;
}

export function UploadLimitCard() {
  const [settings, setSettings] = useState<UploadSettings | undefined>(undefined);
  const [field, setField] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchUploadSettings()
      .then((s) => {
        setSettings(s);
        setField(toField(s));
      })
      .catch(() => setError("failed to load the upload limit"));
  }, []);

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseField(field);
    if (parsed === undefined) {
      setError("enter a positive number of megabytes, or leave empty for no limit");
      return;
    }
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const result = await updateUploadSettings({ maxUploadBytes: parsed });
      setSettings(result);
      setField(toField(result));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to save the upload limit");
    } finally {
      setBusy(false);
    }
  };

  if (settings === undefined) {
    return (
      <div className="ui-card settings-config-card">
        {error ? (
          <p className="text-xs text-(--status-failed)">{error}</p>
        ) : (
          <p className="text-xs text-(--muted)">Loading…</p>
        )}
      </div>
    );
  }

  const effective = settings.effectiveMaxUploadBytes;

  return (
    <div className="ui-card settings-config-card"><h2>Upload limit</h2>
      <p className="mb-1 text-xs text-(--muted)">
        Largest upload <code>POST /run</code> will accept, per file. Applies to the next request — no restart needed.
      </p>
      <p className="mb-4 text-xs text-(--muted)">
        Currently enforcing:{" "}
        {effective === null ? (
          <span className="text-(--status-failed)">no limit</span>
        ) : (
          `${(effective / BYTES_PER_MB).toFixed(0)} MB`
        )}
        {settings.maxUploadBytes === null && effective !== null
          ? ` (the ${(settings.defaultMaxUploadBytes / BYTES_PER_MB).toFixed(0)} MB default — nothing saved yet)`
          : ""}
      </p>
      <form onSubmit={onSave} className="flex flex-col gap-3">
        <label className="settings-form-row">
          Max upload size (MB)
          <input
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder="no limit"
            inputMode="numeric"
            aria-label="Max upload size (MB)"
            className="rounded border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
          />
        </label>

        {field.trim() === "" && (
          // An empty box here means something materially different from an
          // empty box on the Retention card: it removes the protection rather
          // than leaving a threshold off, so it says so instead of reading as
          // merely blank.
          <p className="text-xs text-(--status-failed)">
            Empty means no limit at all — uploads of any size will be accepted.
          </p>
        )}

        {error && <p className="text-xs text-(--status-failed)">{error}</p>}
        {saved && !error && <p className="text-xs text-(--status-running)">Saved.</p>}

        <button
          type="submit"
          disabled={busy}
          className="ui-primary self-start"
        >
          Save upload limit
        </button>
      </form>
    </div>
  );
}
