"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "../lib/api";
import { navigate } from "../lib/navigate";
import { useSessionInfo } from "../lib/useSessionInfo";
import { OrgSwitcher } from "./OrgSwitcher";
import { AppearanceSwitcher } from "./AppearanceSwitcher";
import { Brand } from "./Brand";

function OverviewIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>;
}
function JobsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 3.5h12M2 8h12M2 12.5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="1" cy="3.5" r="0.9" fill="currentColor" />
      <circle cx="1" cy="8" r="0.9" fill="currentColor" />
      <circle cx="1" cy="12.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

function DeviceIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4" y="1.5" width="8" height="13" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7 12.2h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5 13 3.5v3.7c0 3.3-2.1 5.9-5 6.8-2.9-.9-5-3.5-5-6.8V3.5L8 1.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 13c0-2.5 2.2-4.2 5-4.2s5 1.7 5 4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function NotificationsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M2 4.2A1.7 1.7 0 0 1 3.7 2.5h7.6A1.7 1.7 0 0 1 13 4.2v6.6a1.7 1.7 0 0 1-1.7 1.7H3.7A1.7 1.7 0 0 1 2 10.8V4.2Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="m2.6 3.5 4.9 4 4.9-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <rect
        x="1.5" y="2.5" width="12" height="10" rx="1.5"
        stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"
      />
      <path d="M4.3 6.2 6.2 7.9 4.3 9.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.8 9.8h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M5.5 1.5v3.2M9.5 1.5v3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M3.8 4.7h7.4v2.6a3.7 3.7 0 0 1-3.7 3.7 3.7 3.7 0 0 1-3.7-3.7V4.7Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M7.5 11v2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function AboutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7.5 10.6V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7.5" cy="4.9" r="0.9" fill="currentColor" />
    </svg>
  );
}

function ApiIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M5.2 3 2 7.5 5.2 12M9.8 3 13 7.5 9.8 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m8.7 2.5-2.4 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path
        d="M6 13H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3M10 10.5 13.5 7 10 3.5M13.5 7H5.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const LINKS = [
  { href: "/", label: "Overview", icon: OverviewIcon, isActive: (p: string) => p === "/" },
  // "/" is now the landing page (welcome + recent-jobs graph), not the job
  // list - the list moved to /history (bare "/jobs" is a frozen, CI-facing
  // JSON API route in server.ts, not available for a dashboard page). Still
  // matches /jobs/<id> (job detail) as part of the same nav section.
  { href: "/history", label: "Jobs", icon: JobsIcon, isActive: (p: string) => p.startsWith("/history") || p.startsWith("/jobs") },
  { href: "/devices", label: "Devices", icon: DeviceIcon, isActive: (p: string) => p.startsWith("/devices") },
];

export function NavBar() {
  // usePathname(), not a one-time window.location.pathname read: NavBar now
  // stays mounted across client-side Link navigations (that's the point of
  // switching to Link - no reload, no NavBar remount), so the active-link
  // highlight and the /login hide-check both need to react to navigation,
  // not just read the URL once on first mount. Still reports the real
  // browser path even for /jobs/<id> and /orgs/<id>, which have no matching
  // Next route of their own (server.ts pattern-matches and serves the same
  // static shell; those pages read the id back out of the path themselves).
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const sessionInfo = useSessionInfo();

  const links = LINKS;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const onSignOut = async () => {
    try {
      await logout();
    } catch {
      // Swallowed on purpose: the user's intent is to leave regardless of
      // whether logout() succeeded - staying on a page with a stale session
      // on a failed sign-out serves no one, and there is no UI here to
      // surface the failure to anyway.
    } finally {
      navigate("/login");
    }
  };

  // Signed-out visitors land on /login; showing "Jobs | Device | Sign out"
  // there is misleading (those links just bounce back to /login).
  if (pathname === "/login") {
    return null;
  }

  return (
    <nav className="app-navbar flex items-center justify-between gap-2 border-b border-(--border) bg-(--surface) px-3 py-2.5 sm:px-6">
      <div className="flex items-center gap-2 sm:gap-6">
        <Link href="/" aria-label="DeviceYard home" className="flex items-center">
          <span className="hidden sm:inline-flex"><Brand size={32} /></span>
          <span className="inline-flex sm:hidden"><Brand size={32} showName={false} /></span>
        </Link>

        <div className="flex items-center gap-1">
          {links.map(({ href, label, icon: Icon, isActive }) => {
            const active = pathname !== undefined && isActive(pathname);
            return (
              <Link
                key={href}
                href={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-1.5 rounded-md px-2 py-2 text-sm font-medium transition-colors sm:px-3 sm:py-1.5 ${
                  active
                    ? "bg-(--background) text-(--foreground)"
                    : "text-(--muted) hover:bg-(--background) hover:text-(--foreground)"
                }`}
              >
                <Icon />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <OrgSwitcher orgs={sessionInfo?.orgs ?? []} />

        <div ref={menuRef} className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-controls="account-navigation"
            aria-expanded={menuOpen}
            aria-label="Account menu"
            className="flex items-center justify-center rounded-md border border-(--border) p-2 text-(--muted) transition-colors hover:bg-(--background) hover:text-(--foreground)"
          >
            <AccountIcon /><span className="hidden max-w-28 truncate text-xs sm:inline">{sessionInfo?.user.username ?? "Account"}</span><span aria-hidden="true">▾</span>
          </button>

          {menuOpen && (
            <div
              id="account-navigation"
              role="region" aria-label="Account navigation"
              className="absolute right-0 top-full z-10 mt-2 w-56 overflow-hidden rounded-lg border border-(--border) bg-(--surface) shadow-lg shadow-black/30"
            >
              {sessionInfo && (
                <div className="truncate border-b border-(--border) px-3 py-2 text-xs text-(--muted)">
                  Signed in as <span className="text-(--foreground)">{sessionInfo.user.username}</span>
                </div>
              )}
              <div role="group" aria-label="Account">
                <div role="presentation" className="px-3 pb-1 pt-2 text-[0.65rem] font-semibold uppercase tracking-wider text-(--muted)">Account</div>
                <Link
                  href="/account"
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-(--foreground) transition-colors hover:bg-(--background)"
                >
                  <AccountIcon />
                  Account settings
                </Link>
                <Link href="/notifications"  onClick={() => setMenuOpen(false)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-(--foreground) transition-colors hover:bg-(--background)">
                  <NotificationsIcon /> Notifications
                </Link>
              </div>
              <AppearanceSwitcher />
              {sessionInfo?.user.isAdmin && <Link href="/admin" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 border-t border-(--border) px-3 py-2.5 text-sm"><AdminIcon />Farm administration</Link>}
              <div role="group" aria-label="Resources" className="border-t border-(--border)">
                <div role="presentation" className="px-3 pb-1 pt-2 text-[0.65rem] font-semibold uppercase tracking-wider text-(--muted)">Resources</div>
                <Link
                  href="/cli"

                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-(--foreground) transition-colors hover:bg-(--background)"
                >
                  <TerminalIcon />
                  Command line
                </Link>
                <Link
                  href="/mcp-setup"

                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-(--foreground) transition-colors hover:bg-(--background)"
                >
                  <PlugIcon />
                  Connect an agent
                </Link>
                <a
                  href="/api-docs"

                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-(--foreground) transition-colors hover:bg-(--background)"
                >
                  <ApiIcon />
                  API documentation
                </a>
              </div>
              <Link
                href="/about"

                onClick={() => setMenuOpen(false)}
                className="flex w-full items-center gap-2 border-t border-(--border) px-3 py-2.5 text-left text-sm text-(--foreground) transition-colors hover:bg-(--background)"
              >
                <AboutIcon />
                About
              </Link>
              <button

                onClick={onSignOut}
                className="flex w-full items-center gap-2 border-t border-(--border) px-3 py-2.5 text-left text-sm text-(--foreground) transition-colors hover:bg-(--background)"
              >
                <SignOutIcon />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>

    </nav>
  );
}
