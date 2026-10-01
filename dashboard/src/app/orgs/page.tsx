"use client";
import { useEffect, useState } from "react";
import { useRequireSession } from "../../lib/useRequireSession";
import { useSessionInfo } from "../../lib/useSessionInfo";
import { OrgMembersCard } from "../../components/OrgMembersCard";
import { OrgTokensCard } from "../../components/OrgTokensCard";
import { SettingsLayout } from "../../components/SettingsLayout";
import { Skeleton } from "../../components/Skeleton";

// Matches server.ts's GET /orgs/:id fallback (Task 16): everything after
// "/orgs/" is the id, since this same static file is served for any such
// path - identical in spirit to app/jobs/page.tsx's jobIdFromPath.
function orgIdFromPath(pathname: string): number | undefined {
  const match = pathname.match(/^\/orgs\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export default function OrgSettingsPage() {
  const [section, setSection] = useState<"members" | "tokens">("members");
  const [orgId, setOrgId] = useState<number | undefined>(undefined);

  useEffect(() => {
    setOrgId(orgIdFromPath(window.location.pathname));
  }, []);

  const sessionState = useRequireSession();
  const sessionInfo = useSessionInfo();
  const organization = sessionInfo?.orgs.find(org => org.id === orgId);

  if (sessionState !== "ok" || orgId === undefined) {
    return (
      <main className="p-6" role="status" aria-label="Loading">
        <Skeleton className="mb-4 h-6 w-32" />
        <div className="flex max-w-xl flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </main>
    );
  }

  return (
    <SettingsLayout scope="Organization settings" title={section === "members" ? "Members" : "Access tokens"} description={`Manage access to ${organization?.name ?? "this organization"}.`} links={[{ label: "Members", active: section === "members", onClick: () => setSection("members") }, { label: "Access tokens", active: section === "tokens", onClick: () => setSection("tokens") }]}>{section === "members" ? <OrgMembersCard orgId={orgId} /> : <OrgTokensCard orgId={orgId} />}</SettingsLayout>
  );
}
