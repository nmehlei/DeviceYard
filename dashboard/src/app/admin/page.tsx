"use client";
import { useEffect, useState } from "react";
import { ApiError, fetchSession } from "../../lib/api";
import { useRequireSession } from "../../lib/useRequireSession";
import { navigate } from "../../lib/navigate";
import { AdminOrgsCard } from "../../components/AdminOrgsCard";
import { AdminUsersCard } from "../../components/AdminUsersCard";
import { RetentionCard } from "../../components/RetentionCard";
import { UploadLimitCard } from "../../components/UploadLimitCard";
import { ConcurrencyCard } from "../../components/ConcurrencyCard";
import { Skeleton } from "../../components/Skeleton";
import { SettingsLayout } from "../../components/SettingsLayout";
import { BuildingIcon, PeopleIcon } from "../../components/icons";
import { NotificationAdminCard } from "../../components/NotificationAdminCard";
import { MaintenanceCard } from '../../components/MaintenanceCard';

type Tab = "orgs" | "users" | "retention" | "uploads" | "concurrency" | "notifications";

export default function AdminPage() {
  const sessionState = useRequireSession();
  const [isAdmin, setIsAdmin] = useState<boolean | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("orgs");

  useEffect(() => {
    if (sessionState !== "ok") return;
    fetchSession()
      .then((info) => setIsAdmin(info.user.isAdmin))
      .catch((err) => {
        // The session can expire in the narrow window between
        // useRequireSession's own fetchSession() check and this one - a
        // 401/403 here means "invalid session" (-> /login), not "valid
        // session, not an admin" (-> /). Conflating the two would send an
        // expired-session user to "/" instead of back through login, which
        // is exactly the distinction this page exists to preserve.
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          navigate("/login");
          return;
        }
        setIsAdmin(false);
      });
  }, [sessionState]);

  useEffect(() => {
    if (isAdmin === false) navigate("/");
  }, [isAdmin]);

  if (sessionState !== "ok" || isAdmin === undefined) {
    return (
      <main className="p-6" role="status" aria-label="Loading">
        <Skeleton className="mb-4 h-6 w-24" />
        <div className="max-w-xl">
          <Skeleton className="mb-4 h-8 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      </main>
    );
  }
  if (isAdmin === false) {
    return <main className="p-8 text-(--muted)">Redirecting…</main>;
  }

  const access = tab === "orgs" || tab === "users";
  const execution = ["retention", "uploads", "concurrency"].includes(tab);
  return <SettingsLayout scope="Farm administration" title={access ? "Organizations & users" : execution ? "Execution & storage" : "Email delivery"} description="Configure access and shared services for this server instance." links={[
    { label: "Organizations & users", active: access, onClick: () => setTab("orgs") },
    { label: "Execution & storage", active: execution, onClick: () => setTab("retention") },
    { label: "Email delivery", active: tab === "notifications", onClick: () => setTab("notifications") },
  ]}>
    {access && <><div className="settings-tabs" role="tablist" aria-label="Access management">
      <button role="tab" aria-selected={tab === "orgs"} onClick={() => setTab("orgs")}><BuildingIcon />Organizations</button>
      <button role="tab" aria-selected={tab === "users"} onClick={() => setTab("users")}><PeopleIcon />Users</button>
    </div>{tab === "orgs" ? <AdminOrgsCard /> : <AdminUsersCard />}</>}
    {execution && <div className="space-y-5"><MaintenanceCard /><ConcurrencyCard /><RetentionCard /><UploadLimitCard /></div>}
    {tab === "notifications" && <NotificationAdminCard />}
  </SettingsLayout>;
}
