"use client";
import { useState, type FormEvent } from "react";
import { ActionDialog, DialogActions } from "./ActionDialog";
import { PlusIcon } from "./icons";
import { addDevice, ApiError } from "../lib/api";

export function AddDeviceForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [instructions, setInstructions] = useState<string[] | undefined>(undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedId = id.trim();
    if (!trimmedId) {
      setError("id is required - the device's adb serial, from \"adb devices\"");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { setupInstructions } = await addDevice(trimmedId, label.trim() || trimmedId);
      setInstructions(setupInstructions);
      setId("");
      setLabel("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to add device");
    } finally {
      setBusy(false);
    }
  };

  const close = () => { setOpen(false); setInstructions(undefined); setError(undefined); };
  return <>
    <button onClick={() => setOpen(true)} className="ops-action"><PlusIcon />Add device</button>
    <ActionDialog open={open} onClose={close} busy={busy} title="Add device" description="Connect via USB and enable USB debugging before registering.">
    <div>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div>
          <label htmlFor="device-id" className="mb-1 block text-xs text-(--muted)">
            Device id (adb serial)
          </label>
          <input
            id="device-id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. RF8M40H8RFP"
            className="mono w-full rounded-md border border-(--border) bg-(--background) px-2.5 py-1.5 text-sm text-(--foreground)"
          />
        </div>
        <div>
          <label htmlFor="device-label" className="mb-1 block text-xs text-(--muted)">
            Label (optional)
          </label>
          <input
            id="device-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. QA Pixel 7"
            className="w-full rounded-md border border-(--border) bg-(--background) px-2.5 py-1.5 text-sm text-(--foreground)"
          />
        </div>

        {error && <p className="text-xs text-(--status-failed)">{error}</p>}

        <DialogActions onClose={close} busy={busy} label="Register device" />
      </form>

      {instructions && (
        <div className="mt-4 border-t border-(--border) pt-4">
          <p className="mb-2 text-xs font-medium text-(--foreground)">Registered. To bring it online:</p>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-(--muted)">
            {instructions.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      )}
    </div></ActionDialog>
  </>;
}
