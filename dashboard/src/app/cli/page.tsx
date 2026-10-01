"use client";
import { useState } from "react";
import { useRequireSession } from "../../lib/useRequireSession";
import { useSessionInfo } from "../../lib/useSessionInfo";
import { getActiveOrgId } from "../../lib/activeOrg";
import { CopyableCode } from "../../components/CopyableCode";
import { Skeleton } from "../../components/Skeleton";

// Shown until a real org is known - a fresh session with orgs === [] (still
// loading, or a user in no org yet) still renders a complete, readable set of
// snippets rather than blank strings. Same reasoning as the MCP setup page.
const ORG_ID_PLACEHOLDER = "<org-id>";

export default function CliSetupPage() {
  const sessionState = useRequireSession();
  const sessionInfo = useSessionInfo();
  const orgs = sessionInfo?.orgs ?? [];
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

  return (
    <main className="p-6">
      <h1 className="mb-1 text-lg text-(--foreground)">Command line quick start</h1>
      <p className="mb-6 max-w-2xl text-sm text-(--muted)">
        The <code className="mono">deviceyard</code> CLI uploads your app, runs your flows on this farm&apos;s device
        and exits with a code your pipeline can gate on. It mirrors{" "}
        <code className="mono">maestro cloud</code>, so a team already using that changes little more than the binary
        name. Four steps, once per machine.
      </p>

      <div className="flex max-w-2xl flex-col gap-6">
        <section className="rounded-lg border border-(--border) bg-(--surface) p-5">
          <h2 className="mb-2 text-sm font-semibold text-(--foreground)">1. Install it</h2>
          <p className="mb-2 text-sm text-(--muted)">
            No Node needed — this fetches a standalone binary for your platform:
          </p>
          <CopyableCode
            ariaLabel="Copy the curl install command"
            code={`curl -fsSL ${farmUrl}/cli/install.sh | sh`}
          />
          <p className="mb-2 mt-3 text-sm text-(--muted)">Or, if you already have Node 20+:</p>
          <CopyableCode ariaLabel="Copy the npm install command" code="npm install -g @deviceyard/cli" />
        </section>

        <section className="rounded-lg border border-(--border) bg-(--surface) p-5">
          <h2 className="mb-2 text-sm font-semibold text-(--foreground)">2. Create a personal access token</h2>
          <p className="text-sm text-(--muted)">
            Open <span className="text-(--foreground)">Account settings</span> (account menu, top right) and create a
            personal access token. It works across every org you belong to — one credential instead of one per org —
            and stays retrievable from that dialog for as long as it exists.
          </p>
        </section>

        <section className="rounded-lg border border-(--border) bg-(--surface) p-5">
          <h2 className="mb-2 text-sm font-semibold text-(--foreground)">3. Log in</h2>
          <p className="mb-2 text-sm text-(--muted)">
            The token is read from stdin only — never an argument, which would land in your shell history and in{" "}
            <code className="mono">ps</code> output. Paste it, then press Ctrl-D:
          </p>
          <CopyableCode
            ariaLabel="Copy the login command"
            code={`deviceyard login --url ${farmUrl}`}
          />
          <p className="mt-2 text-xs text-(--muted)">
            Stored <code className="mono">0600</code> in <code className="mono">~/.deviceyard/credentials</code>.
          </p>
        </section>

        <section className="rounded-lg border border-(--border) bg-(--surface) p-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-(--foreground)">4. Run your flows</h2>
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
            Point it at your built test APK and your <code className="mono">e2e/scenarios</code> directory. Add{" "}
            <code className="mono">--dry-run</code> first if you want to see what would be submitted without uploading
            anything.
          </p>
          <CopyableCode
            ariaLabel="Copy the run command"
            code={`deviceyard cloud app-testing.apk e2e/scenarios --org ${orgIdText}`}
          />
        </section>

        <section className="rounded-lg border border-(--border) bg-(--surface) p-5">
          <h2 className="mb-2 text-sm font-semibold text-(--foreground)">In CI</h2>
          <p className="mb-2 text-sm text-(--muted)">
            Use an <span className="text-(--foreground)">org token</span> rather than a personal one: it fixes its own
            org, so no <code className="mono">--org</code> is needed and nothing has to be logged in first. Create one
            on the Orgs page and store it as a secret in your CI provider.
          </p>
          <CopyableCode
            ariaLabel="Copy the CI snippet"
            code={[
              `export DEVICEYARD_URL="${farmUrl}"`,
              `export DEVICEYARD_API_KEY="$YOUR_CI_SECRET"`,
              "",
              "npx --yes @deviceyard/cli@latest cloud app-testing.apk e2e/scenarios \\",
              "  --include-tags smoke --report junit",
            ].join("\n")}
          />
          <p className="mt-2 text-xs text-(--muted)">
            Exit codes: <code className="mono">0</code> everything passed, <code className="mono">2</code> a flow
            failed, <code className="mono">1</code> something else went wrong — so a pipeline that retries on{" "}
            <code className="mono">2</code> never retries an infrastructure outage.
          </p>
        </section>
      </div>
    </main>
  );
}
