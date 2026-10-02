"use client";
import { useEffect, useState } from "react";
import { notificationRequest, type Preview } from "../lib/notifications";

export function EmailPreview({ initialKind = "run-result", allTemplates = false }: { initialKind?: string; allTemplates?: boolean }) {
  const [kind, setKind] = useState(initialKind);
  const [format, setFormat] = useState("desktop");
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    notificationRequest<Preview>(`/api/notifications/templates/${kind}`).then((value) => {
      if (!cancelled) { setPreview(value); setError(""); }
    }).catch(() => { if (!cancelled) setError("Preview unavailable. Try selecting another template."); });
    return () => { cancelled = true; };
  }, [kind]);
  return <section className="email-preview" aria-label="Email preview">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2>Email preview</h2></div>
      {allTemplates && <label className="text-sm">Template<select className="notify-input mt-1" value={kind} onChange={(e) => setKind(e.target.value)}>
        {["run-result", "invitation", "password-reset", "email-verification", "device-offline", "device-recovered", "test"].map((name) => <option key={name} value={name}>{name.replaceAll("-", " ")}</option>)}
      </select></label>}</div>
    <div className="mb-4 flex gap-2" aria-label="Preview format">{["desktop", "mobile", "text"].map((value) => <button key={value} className="notify-chip" aria-pressed={format === value} onClick={() => setFormat(value)}>{value === "text" ? "Plain text" : value === "mobile" ? "Mobile" : "Desktop"}</button>)}</div>
    <p className="mb-3 text-xs text-(--muted)">Sample data · links are disabled</p>
    {error ? <p role="alert">{error}</p> : !preview ? <p role="status">Loading preview…</p> : <>
      <p className="mb-3 text-sm text-(--muted)"><span className="font-medium text-(--foreground)">Subject:</span> {preview.subject}</p>
      {format === "text" ? <pre className="whitespace-pre-wrap rounded-xl bg-(--background) p-5 text-sm leading-7">{preview.text}</pre> :
        <iframe title="Sample notification email" sandbox="" srcDoc={preview.html} className="mx-auto block h-[650px] max-w-full rounded-xl border-0 bg-white" style={{ width: format === "mobile" ? 360 : 600 }} />}
    </>}
  </section>;
}
