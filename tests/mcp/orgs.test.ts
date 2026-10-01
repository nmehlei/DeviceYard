import { createOrgResolver } from "../../src/mcp/orgs";
import type { FarmClient } from "../../src/mcp/client";

function clientWith(orgs: Array<{ id: number; name: string }>, onCall?: () => void): FarmClient {
  return {
    getJson: async () => { onCall?.(); return { orgs } as never; },
    getBinary: async () => ({ bytes: Buffer.alloc(0), contentType: "", totalBytes: 0, partial: false }),
    postForm: async () => ({ id: "x", status: "queued" }),
    openEvents: async () => undefined,
  } as unknown as FarmClient;
}

const TWO = [{ id: 1, name: "donable" }, { id: 2, name: "nme" }];

describe("org selection precedence", () => {
  it("uses an explicit argument above everything else", async () => {
    const r = createOrgResolver(clientWith(TWO), { MOBILE_FARM_ORG: "nme" });
    expect(await r.resolve("donable")).toEqual({ id: 1, name: "donable" });
  });

  it("falls back to MOBILE_FARM_ORG", async () => {
    const r = createOrgResolver(clientWith(TWO), { MOBILE_FARM_ORG: "nme" });
    expect((await r.resolve()).name).toBe("nme");
  });

  it("uses the only org when there is exactly one", async () => {
    const r = createOrgResolver(clientWith([{ id: 5, name: "solo" }]), {});
    expect((await r.resolve()).name).toBe("solo");
  });

  it("refuses to guess between several, and names them", async () => {
    const r = createOrgResolver(clientWith(TWO), {});
    await expect(r.resolve()).rejects.toThrow(/donable.*nme|nme.*donable/s);
  });

  it("rejects an org the caller does not belong to, listing what they do have", async () => {
    const r = createOrgResolver(clientWith(TWO), {});
    await expect(r.resolve("foreign")).rejects.toThrow(/foreign/);
  });

  it("matches org names case-insensitively", async () => {
    const r = createOrgResolver(clientWith(TWO), {});
    expect((await r.resolve("DONABLE")).id).toBe(1);
  });

  it("fetches the org list once and caches it", async () => {
    let calls = 0;
    const r = createOrgResolver(clientWith(TWO, () => { calls += 1; }), {});
    await r.resolve("donable");
    await r.resolve("nme");
    expect(calls).toBe(1);
  });
});

describe("describeDefault", () => {
  it("reports MOBILE_FARM_ORG when configured", async () => {
    const r = createOrgResolver(clientWith(TWO), { MOBILE_FARM_ORG: "nme" });
    expect(r.describeDefault()).toBe("MOBILE_FARM_ORG=nme");
  });

  // Cheap item 2: a sole-membership holder's calls DO default correctly
  // (resolve() returns the only org without being asked) - "no default
  // configured" actively misled them into thinking otherwise. Fails against
  // the unfixed code, which returns that fixed string regardless of
  // membership.
  it("reports sole membership as the default reason once list() has resolved it", async () => {
    const r = createOrgResolver(clientWith([{ id: 5, name: "solo" }]), {});
    await r.resolve();
    expect(r.describeDefault()).toMatch(/solo/);
    expect(r.describeDefault()).toMatch(/sole membership/i);
  });

  it("still says 'no default configured' before list() has ever run", () => {
    const r = createOrgResolver(clientWith([{ id: 5, name: "solo" }]), {});
    expect(r.describeDefault()).toBe("no default configured");
  });

  it("says 'no default configured' for several orgs and no MOBILE_FARM_ORG", async () => {
    const r = createOrgResolver(clientWith(TWO), {});
    await r.list();
    expect(r.describeDefault()).toBe("no default configured");
  });
});
