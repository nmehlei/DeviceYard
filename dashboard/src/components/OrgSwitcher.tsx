"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Org } from "../lib/api";
import { getActiveOrgId, setActiveOrgId } from "../lib/activeOrg";
import { navigate } from "../lib/navigate";
import { ShieldIcon } from "./icons";

export function OrgSwitcher({ orgs }: { orgs: Org[] }) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<number | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveId(getActiveOrgId());
  }, [orgs]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  if (orgs.length === 0) return null;

  const active = orgs.find((o) => o.id === activeId) ?? orgs[0];

  const selectOrg = (orgId: number) => {
    setActiveOrgId(orgId);
    setOpen(false);
    // Every job/artifact fetch already in flight or about to render on this
    // page assumed the PREVIOUS active org - a full navigation is the
    // simplest way to guarantee nothing stale is left on screen.
    navigate("/");
  };

  return (
    <div ref={ref} className="relative min-w-0 max-w-36 sm:max-w-64">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex max-w-full items-center gap-1.5 rounded-md border border-(--border) px-2.5 py-1.5 text-sm text-(--foreground)"
      >
        <ShieldIcon /><span className="truncate">{active.name}</span>
        <span className="text-xs text-(--muted)">▾</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-2 w-56 overflow-hidden rounded-lg border border-(--border) bg-(--surface) shadow-lg shadow-black/30"
        >
          <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-(--muted)">Your orgs</div>
          {orgs.map((org) => (
            <button
              key={org.id}
              onClick={() => selectOrg(org.id)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-(--background) ${
                org.id === active.id ? "text-(--status-running)" : "text-(--foreground)"
              }`}
            >
              {org.name}
              {org.id === active.id && <span>✓</span>}
            </button>
          ))}
          <div className="border-t border-(--border)" />
          <Link
            href={`/orgs/${active.id}`}
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-xs text-(--muted) hover:text-(--foreground)"
          >
            Organization settings · {active.name} →
          </Link>
        </div>
      )}
    </div>
  );
}
