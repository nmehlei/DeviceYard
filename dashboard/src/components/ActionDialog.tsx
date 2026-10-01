"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { KeyIcon, PlusIcon, CheckIcon, TrashIcon } from "./icons";

export function ActionDialog({ open, onClose, title, description, target, danger = false, busy = false, children }: {
  open: boolean; onClose: () => void; title: string; description?: string; target?: string;
  danger?: boolean; busy?: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const trigger = document.activeElement as HTMLElement | null;
    dialog.showModal();
    if (danger) dialog.querySelector<HTMLButtonElement>("[data-dialog-cancel]")?.focus();
    else dialog.querySelector<HTMLElement>("input, select, textarea, [data-dialog-cancel]")?.focus();
    return () => { dialog.close(); trigger?.focus(); };
  }, [open, danger]);
  return <dialog ref={ref} className={`action-dialog ${danger ? "action-dialog-danger" : ""}`} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    {open && <>
      <div className="action-dialog-heading"><span className="action-dialog-icon">{danger ? <KeyIcon /> : <PlusIcon />}</span>
        <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
        <button type="button" className="dialog-close" aria-label="Close dialog" disabled={busy} onClick={onClose}>×</button>
      </div>
      <div className="action-dialog-content">{target && <div className="dialog-target">{target}</div>}{children}</div>
    </>}
  </dialog>;
}

export function DialogActions({ onClose, busy, label, danger = false, onConfirm }: { onClose: () => void; busy: boolean; label: string; danger?: boolean; onConfirm?: () => void }) {
  return <div className="dialog-actions">
    <button type="button" className="ui-button" data-dialog-cancel disabled={busy} onClick={onClose}>Cancel</button>
    <button type={onConfirm ? "button" : "submit"} className={`ui-primary ${danger ? "ui-danger" : ""}`} disabled={busy} onClick={onConfirm}>{danger ? <TrashIcon /> : <CheckIcon />}{busy ? "Working…" : label}</button>
  </div>;
}
