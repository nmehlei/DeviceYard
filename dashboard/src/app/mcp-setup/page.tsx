"use client";
import { useState } from "react";
import { useRequireSession } from "../../lib/useRequireSession";
import { useSessionInfo } from "../../lib/useSessionInfo";
import { getActiveOrgId } from "../../lib/activeOrg";
import { CopyableCode } from "../../components/CopyableCode";
import { Skeleton } from "../../components/Skeleton";

// Placeholders shown until a real org is known - a fresh session with
// orgs === [] (still loading, or a user in no org yet) still renders a
// complete, readable set of snippets rather than blank strings.
const ORG_ID_PLACEHOLDER = "<org-id>";
const ORG_NAME_PLACEHOLDER = "<org-name>";

export default function McpSetupPage() {
  const sessionState = useRequireSession();
  const sessionInfo = useSessionInfo();
  const orgs = sessionInfo?.orgs ?? [];
  // undefined means "no explicit pick yet" - defaulted below, every render,
  // to whichever org is already active in this tab (same id OrgSwitcher and
  // every org-scoped API call use). Deriving the default at render time
  // rather than via a setState-in-effect avoids an extra render pass and
  // stays correct across orgs arriving asynchronously after first paint.
  const [pickedOrgId, setPickedOrgId] = useState<number | undefined>(undefined);
  const activeOrgId = getActiveOrgId();
  const defaultOrgId = orgs.some((o) => o.id === activeOrgId) ? activeOrgId : orgs[0]?.id;
  const selectedOrgId = pickedOrgId ?? defaultOrgId;

  if (sessionState !== "ok") {
    return (
      <main className="p-6" role="status" aria-label="Loading">
        <Skeleton className="mb-4 h-6 w-40" />
        <Skeleton className="h-64 w-full max-w-2xl" />
      </main>
    );
  }

  const selectedOrg = orgs.find((o) => o.id === selectedOrgId);
  const farmUrl = typeof window !== "undefined" ? window.location.origin : "";
  const orgIdText = selectedOrg ? String(selectedOrg.id) : ORG_ID_PLACEHOLDER;
  const orgNameText = selectedOrg ? selectedOrg.name : ORG_NAME_PLACEHOLDER;

  return (
    <main className="p-6">
      <h1 className="mb-1 text-lg text-(--foreground)">Connect an agent</h1>
      <p className="mb-6 max-w-2xl text-sm text-(--muted)">
        A coding agent can run flows on the physical device and read back the evidence itself, through the farm&apos;s
        own MCP client — no `node_modules` to install, no human relaying screenshots. Follow these four steps once per
        machine.
      </p>

      <div className="flex max-w-2xl flex-col gap-6">
        <section className="rounded-lg border border-(--border) bg-(--surface) p-5">
          <h2 className="mb-2 text-sm font-semibold text-(--foreground)">1. Create a personal access token</h2>
          <p className="text-sm text-(--muted)">
            Open <span className="text-(--foreground)">Account settings</span> (account menu, top right) and create a
            personal access token (PAT). It works across every org you belong to — one credential instead of one per
            org — and stays retrievable from that dialog for as long as it exists.
          </p>
        </section>

        <section className="rounded-lg border border-(--border) bg-(--surface) p-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-(--foreground)">2. Download the client bundle</h2>
            {orgs.length > 1 && (
              <label className="flex items-center gap-2 text-xs text-(--muted)">
                Org
                <select
                  value={selectedOrgId ?? ""}
                  onChange={(e) => setPickedOrgId(Number(e.target.value))}
                  className="rounded-md border border-(--border) bg-(--background) px-2 py-1 text-xs text-(--foreground)"
                >
                  {orgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="mb-2 text-sm text-(--muted)">
            Set your PAT as <code className="mono">$MOBILE_FARM_PAT</code>, then run:
          </p>
          <CopyableCode
            ariaLabel="Copy download commands"
            code={[
              "mkdir -p ~/.mobile-farm",
              "",
              `curl -fsSL -H "Authorization: Bearer $MOBILE_FARM_PAT" -H "X-Org-Id: ${orgIdText}" \\`,
              `  "${farmUrl}/api/mcp-client" -o ~/.mobile-farm/mcp.mjs`,
            ].join("\n")}
          />
          <p className="mt-2 text-xs text-(--muted)">
            The download itself isn&apos;t org-specific — any org you belong to works here. Don&apos;t know an org id?{" "}
            <code className="mono">GET /api/me/orgs</code> with a PAT and no <code className="mono">X-Org-Id</code>{" "}
            lists them.
          </p>
        </section>

        <section className="rounded-lg border border-(--border) bg-(--surface) p-5">
          <h2 className="mb-2 text-sm font-semibold text-(--foreground)">3. Save the credential</h2>
          <p className="mb-2 text-sm text-(--muted)">
            Save it to <code className="mono">~/.mobile-farm/credentials</code>, never into a per-repository file. The
            client reads it from stdin only — paste the token, then press Ctrl-D:
          </p>
          <CopyableCode
            ariaLabel="Copy save-credential command"
            code={`MOBILE_FARM_URL="${farmUrl}" node ~/.mobile-farm/mcp.mjs --save-credential`}
          />
        </section>

        <section className="rounded-lg border border-(--border) bg-(--surface) p-5">
          <h2 className="mb-2 text-sm font-semibold text-(--foreground)">4. Point your harness at it</h2>
          <p className="mb-2 text-sm text-(--muted)">
            This config holds no secret — only a URL and a non-secret org name. The credential lives once, in{" "}
            <code className="mono">~/.mobile-farm/credentials</code>, which is why it&apos;s safe to commit.
          </p>

          <p className="mb-1 text-xs uppercase tracking-wide text-(--muted)">Claude Code (.mcp.json)</p>
          <CopyableCode
            ariaLabel="Copy Claude Code MCP config"
            code={JSON.stringify(
              {
                mcpServers: {
                  "mobile-farm": {
                    command: "node",
                    args: ["~/.mobile-farm/mcp.mjs"],
                    env: { MOBILE_FARM_URL: farmUrl, MOBILE_FARM_ORG: orgNameText },
                  },
                },
              },
              null,
              2
            )}
          />

          <p className="mb-1 mt-3 text-xs uppercase tracking-wide text-(--muted)">Codex (config.toml)</p>
          <CopyableCode
            ariaLabel="Copy Codex MCP config"
            code={[
              "[mcp_servers.mobile-farm]",
              'command = "node"',
              'args = ["~/.mobile-farm/mcp.mjs"]',
              `env = { MOBILE_FARM_URL = "${farmUrl}", MOBILE_FARM_ORG = "${orgNameText}" }`,
            ].join("\n")}
          />
        </section>

        <section className="rounded-lg border border-(--border) bg-(--surface) p-5">
          <h2 className="mb-2 text-sm font-semibold text-(--foreground)">Worth knowing</h2>
          <ul className="flex flex-col gap-2 text-sm text-(--muted)">
            <li>
              ⚠️ <span className="text-(--foreground)">Screenshots go to your model backend.</span>{" "}
              <code className="mono">get_artifact</code> returns real, logged-in app screenshots as inline images —
              they travel to whatever model your harness uses, like any other tool result.
            </li>
            <li>
              ⚠️ <span className="text-(--foreground)">The device is shared and singular.</span> A run takes the one
              physical phone for its duration. An agent looping on flows queues behind — and ahead of — your CI.
            </li>
            <li>
              CI keeps using an org token (<code className="mono">MOBILE_FARM_TOKEN</code>) instead of a PAT — it
              fixes the org by definition and wins over any saved credential.
            </li>
          </ul>
        </section>

        <section className="rounded-lg border border-(--border) bg-(--surface) p-5">
          <h2 className="mb-2 text-sm font-semibold text-(--foreground)">The tools</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-(--muted)">
                  <th className="pb-1 pr-3 font-medium">Tool</th>
                  <th className="pb-1 font-medium">What it does</th>
                </tr>
              </thead>
              <tbody className="text-(--foreground)">
                {[
                  ["run_flows", "Uploads the APK and flows, exactly as CI does. Returns a job id immediately."],
                  ["wait_for_job", "Consumes the job's SSE stream and returns its state."],
                  ["get_job", "Full detail: every flow, its verdict, artifact ids."],
                  ["list_jobs", "Recent jobs for the org, newest first."],
                  ["get_artifact", "A screenshot, log tail, or link, by artifact id."],
                  ["get_device", "Registered devices and live adb state. Farm-wide, no org argument."],
                  ["list_orgs", "Which orgs this credential can act on, and which is default."],
                ].map(([tool, desc]) => (
                  <tr key={tool} className="border-t border-(--border)">
                    <td className="mono py-1.5 pr-3">{tool}</td>
                    <td className="py-1.5">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
