// src/mcp/tools/reads.ts
import { FarmError, type FarmClient } from "../client";
import { formatJobDetail, formatJobList } from "../format";
import { textResult, errorResult, type ToolResult } from "../result";
import type { DeviceResponse, JobDetail, JobListResponse } from "../apiTypes";

/** Every tool funnels failures through here. An agent can only act on an
 * error it understands, so each kind names the thing the agent (or its
 * human) can actually change. */
export function describeFarmError(err: unknown): string {
  if (err instanceof FarmError) {
    switch (err.kind) {
      case "auth":
        // Deliberately does not name MOBILE_FARM_TOKEN unconditionally: for a
        // personal access token that variable is not what to check (the
        // credential lives in ~/.mobile-farm/credentials instead), and
        // FarmError's own message (src/mcp/client.ts) already carries the
        // farm's specific reason, which is more actionable than either.
        return `${err.message} Check the credential this tool is using: MOBILE_FARM_TOKEN for an org token, ` +
          `or the saved personal access token in ~/.mobile-farm/credentials.`;
      case "not_found":
        return `${err.message} Note the farm does not distinguish "does not exist" from "belongs to another org".`;
      case "unreachable":
        return `${err.message} Check MOBILE_FARM_URL and that you are on a network that can reach the farm.`;
      case "timeout":
        return `${err.message} Raise MOBILE_FARM_TIMEOUT_MS if this is a slow but healthy request.`;
      case "server":
        return `${err.message} The farm itself failed, not your request; check its logs, and a retry is reasonable if this looks transient.`;
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export async function getJob(client: FarmClient, args: { jobId: string }): Promise<ToolResult> {
  try {
    return textResult(formatJobDetail(await client.getJson<JobDetail>(`/api/jobs/${encodeURIComponent(args.jobId)}`)));
  } catch (err) {
    return errorResult(describeFarmError(err));
  }
}

export async function listJobs(client: FarmClient, args: { limit?: number }): Promise<ToolResult> {
  // Mirrors the server's own clamp (src/api/jobs.ts) rather than trusting
  // it: a negative limit is a SQLite "unbounded" footgun the server already
  // guards, and sending one anyway is a pointless round-trip. `limit: 0` is
  // defined-but-falsy, so it must be checked against `undefined` explicitly
  // rather than via `??` - otherwise it silently becomes 50 instead of
  // clamping to 1, and a non-numeric value must fall back to 50 rather than
  // leaking `NaN` into the URL. It must also be FLOORED: the value ends up
  // in a SQL `LIMIT ?` on the server, where `1.5` is an error, not a clamp
  // (clampWaitSeconds floors for the same reason).
  const raw = args.limit === undefined ? 50 : Number(args.limit);
  const limit = Math.max(1, Math.min(Math.floor(Number.isFinite(raw) ? raw : 50), 200));
  try {
    const payload = await client.getJson<JobListResponse>(`/api/jobs?limit=${limit}`);
    return textResult(formatJobList(payload.jobs));
  } catch (err) {
    return errorResult(describeFarmError(err));
  }
}

export async function getDevice(client: FarmClient): Promise<ToolResult> {
  try {
    // Note the plural: there is no /api/device route.
    const payload = await client.getJson<DeviceResponse>("/api/devices");
    return textResult(JSON.stringify(payload, null, 2));
  } catch (err) {
    return errorResult(describeFarmError(err));
  }
}
