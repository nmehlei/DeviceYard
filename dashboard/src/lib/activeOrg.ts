const STORAGE_KEY = "mdf_active_org_id";

/** sessionStorage, not localStorage or a cookie: genuinely per-tab, so
 * switching the active org in one tab never affects another - see the
 * spec's "Current org" decision for why that property matters. */
export function getActiveOrgId(): number | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? Number(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function setActiveOrgId(orgId: number): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, String(orgId));
  } catch {
    // sessionStorage unavailable (privacy mode, etc.) - the active org just
    // won't persist across a reload in that tab. Not fatal.
  }
}

/** Called on logout, and whenever fetchSession()/login() finds the stored
 * org id no longer valid for the now-current user (see api.ts) - without
 * this, a stale org id survives sign-out/user-switching in the same tab
 * (sessionStorage is per-tab, not per-session) and a different user can
 * inherit an org id they don't belong to. */
export function clearActiveOrgId(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // sessionStorage unavailable - nothing to clear.
  }
}

/** Wraps a fetch implementation to attach X-Org-Id from the active org, if
 * one is set. Used as the default fetchImpl for every org-scoped api.ts
 * call (jobs, artifacts, org settings) - never for login/session calls,
 * which run before any org context exists.
 *
 * fetchImpl defaults to `undefined`, resolved to the bare `fetch` global
 * lazily inside the returned closure - not as a JS default parameter, which
 * would evaluate the `fetch` identifier eagerly at the moment orgScopedFetch()
 * itself is called. That matters because orgScopedFetch() is called once at
 * module load in useJobEvents.ts to build a stable default (see its own
 * comment) - eager evaluation there throws in any environment that hasn't
 * defined a global `fetch` yet (Next's static-export prerender pass, or a
 * jsdom test that only sets global.fetch inside a test body), the same class
 * of ReferenceError this file's EventSource handling was already written to
 * avoid. */
export function orgScopedFetch(fetchImpl?: typeof fetch): typeof fetch {
  return (input, init) => {
    const impl = fetchImpl ?? fetch;
    const orgId = getActiveOrgId();
    if (orgId === undefined) return impl(input, init);
    const headers = new Headers(init?.headers);
    headers.set("X-Org-Id", String(orgId));
    return impl(input, { ...init, headers });
  };
}
