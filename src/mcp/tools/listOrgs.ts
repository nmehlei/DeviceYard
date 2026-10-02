// src/mcp/tools/listOrgs.ts
import type { OrgResolver } from "../orgs";
import type { Credential } from "../credentials";
import { textResult, errorResult, type ToolResult } from "../result";
import { describeFarmError } from "./reads";

export async function listOrgs(resolver: OrgResolver, credential: Credential): Promise<ToolResult> {
  // GET /api/me/orgs needs an identity (src/api/me.ts's anyIdentity), and an
  // org token sets neither req.userId nor req.patUserId - it authenticates
  // as the org, not as a person. Calling it anyway would always come back
  // 401 "login required", which (via describeFarmError) reads to the agent
  // as "the farm rejected the credential" - misleading for a token that is
  // working exactly as designed. Short-circuit instead of making a call
  // that cannot succeed.
  if (credential.kind === "org") {
    return textResult(
      "this is an org token (MOBILE_FARM_TOKEN), fixed to the single org it was issued for. " +
      "It cannot act on any other org, and there is no list to show - switch to a personal access " +
      "token to work across orgs.",
    );
  }
  try {
    const orgs = await resolver.list();
    if (orgs.length === 0) return textResult("this credential belongs to no orgs");
    const lines = orgs.map((o) => `  ${o.name} (id ${o.id})`).join("\n");
    return textResult(
      `orgs this credential can act on:\n${lines}\n\nDefault when a call does not name one: ${resolver.describeDefault()}`,
    );
  } catch (err) {
    return errorResult(describeFarmError(err));
  }
}
