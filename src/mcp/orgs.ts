import type { FarmClient } from "./client";

export interface OrgEntry {
  id: number;
  name: string;
}

export interface OrgResolver {
  list(): Promise<OrgEntry[]>;
  resolve(explicit?: string): Promise<OrgEntry>;
  describeDefault(): string;
}

/** X-Org-Id takes a numeric id; people say "donable". This resolves names to
 * ids against GET /api/me/orgs and caches the answer for the process. */
export function createOrgResolver(client: FarmClient, env: NodeJS.ProcessEnv = process.env): OrgResolver {
  let cached: OrgEntry[] | undefined;
  const configured = env.MOBILE_FARM_ORG?.trim();

  async function list(): Promise<OrgEntry[]> {
    if (!cached) {
      const payload = await client.getJson<{ orgs: OrgEntry[] }>("/api/me/orgs");
      cached = payload.orgs;
    }
    return cached;
  }

  function find(orgs: OrgEntry[], name: string): OrgEntry | undefined {
    return orgs.find((o) => o.name.toLowerCase() === name.toLowerCase());
  }

  return {
    list,

    describeDefault(): string {
      if (configured) return `MOBILE_FARM_ORG=${configured}`;
      // `cached` is only populated once list() has actually run - by the
      // time list_orgs calls this (after its own `await resolver.list()`),
      // it has. A sole-membership holder's calls DO default correctly (see
      // resolve() above), so reporting "no default configured" here was
      // actively misleading, not just uninformative.
      if (cached && cached.length === 1) {
        return `${cached[0].name} (sole membership - your only org, so calls default to it automatically)`;
      }
      return "no default configured";
    },

    async resolve(explicit?: string): Promise<OrgEntry> {
      const orgs = await list();
      const names = orgs.map((o) => o.name).join(", ") || "none";

      const wanted = explicit?.trim() || configured;
      if (wanted) {
        const match = find(orgs, wanted);
        if (!match) throw new Error(`you are not a member of an org called "${wanted}". Your orgs: ${names}`);
        return match;
      }

      // Never guess. Picking an org silently would run a flow against another
      // tenant's device and write artifacts into their job history.
      if (orgs.length === 1) return orgs[0];
      if (orgs.length === 0) throw new Error("this credential belongs to no orgs; ask an admin to add you to one");
      throw new Error(
        `you belong to several orgs, so this call has to say which one: ${names}. ` +
        `Pass org="<name>", or set MOBILE_FARM_ORG in your MCP config to pin a default.`,
      );
    },
  };
}
