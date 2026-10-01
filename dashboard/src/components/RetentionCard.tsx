"use client";
import { useEffect, useState, type FormEvent } from "react";
import { fetchRetentionSettings, updateRetentionSettings, ApiError, type RetentionSettings } from "../lib/api";

// Kept as strings while editing, not numbers, so a field can sit empty
// mid-typing without being coerced to 0 - an empty field means "disabled"
// (null) on save, matching the API's null-means-disabled contract
// (src/api/admin.ts).
interface FieldState {
  maxAgeDays: string;
  maxTotalBytes: string;
  maxJobs: string;
}

function toFieldState(settings: Pick<RetentionSettings, "maxAgeDays" | "maxTotalBytes" | "maxJobs">): FieldState {
  return {
    maxAgeDays: settings.maxAgeDays === null ? "" : String(settings.maxAgeDays),
    maxTotalBytes: settings.maxTotalBytes === null ? "" : String(settings.maxTotalBytes),
    maxJobs: settings.maxJobs === null ? "" : String(settings.maxJobs),
  };
}

/** Returns the parsed value, `null` for an empty (disabled) field, or
 * `undefined` as a sentinel for an invalid one - distinct from a parsed
 * `null`, matching the same three-way parse the server does. */
function parseField(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

export function RetentionCard() {
  const [settings, setSettings] = useState<RetentionSettings | undefined>(undefined);
  const [fields, setFields] = useState<FieldState>({ maxAgeDays: "", maxTotalBytes: "", maxJobs: "" });
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchRetentionSettings()
      .then((s) => {
        setSettings(s);
        setFields(toFieldState(s));
      })
      .catch(() => setError("failed to load retention settings"));
  }, []);

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = {
      maxAgeDays: parseField(fields.maxAgeDays),
      maxTotalBytes: parseField(fields.maxTotalBytes),
      maxJobs: parseField(fields.maxJobs),
    };
    if (Object.values(parsed).some((v) => v === undefined)) {
      setError("each field must be a non-negative whole number, or empty to disable");
      return;
    }

    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const result = await updateRetentionSettings({
        maxAgeDays: parsed.maxAgeDays as number | null,
        maxTotalBytes: parsed.maxTotalBytes as number | null,
        maxJobs: parsed.maxJobs as number | null,
      });
      setSettings(result);
      setFields(toFieldState(result));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to save retention settings");
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

  return (
    <div className="ui-card settings-config-card"><h2>Artifact retention</h2>
      <p className="mb-4 text-xs text-(--muted)">
        Current artifact storage: {(settings.totalArtifactBytes / (1024 * 1024)).toFixed(1)} MB
      </p>
      <p className="mb-4 text-xs text-(--muted)">Set cleanup thresholds. An empty field disables that threshold. Lower thresholds can cause older jobs and their artifacts to be deleted by cleanup.</p>
      <form onSubmit={onSave} className="flex flex-col gap-3">
        <label className="settings-form-row">
          Max age (days)
          <input
            value={fields.maxAgeDays}
            onChange={(e) => setFields({ ...fields, maxAgeDays: e.target.value })}
            placeholder="disabled"
            inputMode="numeric"
            className="rounded border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
          />
        </label>
        <label className="settings-form-row">
          Max total artifact bytes
          <input
            value={fields.maxTotalBytes}
            onChange={(e) => setFields({ ...fields, maxTotalBytes: e.target.value })}
            placeholder="disabled"
            inputMode="numeric"
            className="rounded border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
          />
        </label>
        <label className="settings-form-row">
          Max job count
          <input
            value={fields.maxJobs}
            onChange={(e) => setFields({ ...fields, maxJobs: e.target.value })}
            placeholder="disabled"
            inputMode="numeric"
            className="rounded border border-(--border) bg-(--background) px-2 py-1 text-sm text-(--foreground)"
          />
        </label>

        {error && <p className="text-xs text-(--status-failed)">{error}</p>}
        {saved && !error && <p className="text-xs text-(--status-running)">Saved.</p>}

        <button
          type="submit"
          disabled={busy}
          className="ui-primary self-start"
        >
          Save retention
        </button>
      </form>
    </div>
  );
}
