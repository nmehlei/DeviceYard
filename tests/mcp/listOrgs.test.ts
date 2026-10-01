import { listOrgs } from "../../src/mcp/tools/listOrgs";
import type { OrgResolver } from "../../src/mcp/orgs";
import type { Credential } from "../../src/mcp/credentials";

const personalCredential: Credential = { token: "t", kind: "personal" };
const orgCredential: Credential = { token: "t", kind: "org" };

function resolver(orgs: Array<{ id: number; name: string }>, def = "no default configured"): OrgResolver {
  return {
    list: async () => orgs,
    resolve: async () => orgs[0],
    describeDefault: () => def,
  };
}

describe("list_orgs", () => {
  it("names every org the credential can act on", async () => {
    const result = await listOrgs(resolver([{ id: 1, name: "donable" }, { id: 2, name: "nme" }]), personalCredential);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("donable");
    expect(text).toContain("nme");
  });

  it("says which default applies and why", async () => {
    const result = await listOrgs(resolver([{ id: 1, name: "donable" }], "MOBILE_FARM_ORG=donable"), personalCredential);
    expect((result.content[0] as { text: string }).text).toContain("MOBILE_FARM_ORG=donable");
  });

  it("returns an error result rather than throwing when discovery fails", async () => {
    const broken: OrgResolver = {
      list: async () => { throw new Error("farm unreachable"); },
      resolve: async () => { throw new Error("x"); },
      describeDefault: () => "",
    };
    const result = await listOrgs(broken, personalCredential);
    expect(result.isError).toBe(true);
  });

  // I4: GET /api/me/orgs needs an identity, and an org token has none (it
  // authenticates as the org, not as a person) - the pre-fix code called
  // resolver.list() unconditionally, which for an org token always 401s
  // "login required", surfacing as the generic, misleading "the farm
  // rejected the credential" via describeFarmError/client.ts.
  it("short-circuits for an org token rather than making a call that can only fail", async () => {
    const neverCalled = resolver([{ id: 1, name: "donable" }]);
    const spy = jest.spyOn(neverCalled, "list");
    const result = await listOrgs(neverCalled, orgCredential);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/org token/i) });
    expect(spy).not.toHaveBeenCalled();
  });
});
