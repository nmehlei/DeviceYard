import { getActiveOrgId, setActiveOrgId, orgScopedFetch } from "../../src/lib/activeOrg";

beforeEach(() => {
  sessionStorage.clear();
});

test("getActiveOrgId returns undefined when nothing has been set", () => {
  expect(getActiveOrgId()).toBeUndefined();
});

test("setActiveOrgId then getActiveOrgId round-trips", () => {
  setActiveOrgId(42);
  expect(getActiveOrgId()).toBe(42);
});

test("orgScopedFetch adds an X-Org-Id header when an active org is set", async () => {
  setActiveOrgId(7);
  const fakeFetch = jest.fn().mockResolvedValue({ ok: true });
  await orgScopedFetch(fakeFetch)("/api/jobs");

  const [, init] = fakeFetch.mock.calls[0];
  expect(new Headers(init.headers).get("X-Org-Id")).toBe("7");
});

test("orgScopedFetch sends no X-Org-Id header when nothing is set", async () => {
  const fakeFetch = jest.fn().mockResolvedValue({ ok: true });
  await orgScopedFetch(fakeFetch)("/api/jobs");

  const [, init] = fakeFetch.mock.calls[0];
  expect(new Headers(init?.headers).has("X-Org-Id")).toBe(false);
});

test("orgScopedFetch preserves other init options (method, credentials)", async () => {
  setActiveOrgId(7);
  const fakeFetch = jest.fn().mockResolvedValue({ ok: true });
  await orgScopedFetch(fakeFetch)("/api/jobs", { method: "POST", credentials: "include" });

  const [, init] = fakeFetch.mock.calls[0];
  expect(init.method).toBe("POST");
  expect(init.credentials).toBe("include");
});
