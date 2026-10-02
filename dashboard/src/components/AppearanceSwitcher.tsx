"use client";
import { useSyncExternalStore } from "react";
type Appearance = "light" | "dark" | "system";
const key = "deviceyard-appearance";
function read(): Appearance { const current = document.documentElement.dataset.theme; return current === "light" || current === "dark" ? current : "system"; }
function subscribe(callback: () => void) { const storage = () => { try { document.documentElement.dataset.theme = localStorage.getItem(key) ?? "system"; } catch {} callback(); }; window.addEventListener("storage", storage); window.addEventListener("appearance-change", callback); return () => { window.removeEventListener("storage", storage); window.removeEventListener("appearance-change", callback); }; }
export function AppearanceSwitcher() {
  const appearance = useSyncExternalStore(subscribe, read, () => "system" as Appearance);
  const select = (value: Appearance) => {
    try { localStorage.setItem(key, value); } catch { /* Current page still changes without storage. */ }
    document.documentElement.setAttribute("data-theme", value);
    window.dispatchEvent(new Event("appearance-change"));
  };
  return <div className="appearance-control"><p>Appearance</p><div aria-label="Appearance">{(["light", "dark", "system"] as const).map((value, i) => <button key={value} type="button" aria-pressed={appearance === value} onClick={() => select(value)}><span aria-hidden="true">{["☀", "☾", "▣"][i]}</span>{value[0].toUpperCase() + value.slice(1)}</button>)}</div></div>;
}
