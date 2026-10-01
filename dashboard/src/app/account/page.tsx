"use client";
import { useRequireSession } from "../../lib/useRequireSession";
import { useSessionInfo } from "../../lib/useSessionInfo";
import { SettingsLayout } from "../../components/SettingsLayout";
import { ChangePasswordCard } from "../../components/ChangePasswordCard";
import PersonalTokensCard from "../../components/PersonalTokensCard";
export default function AccountPage() {
  const session = useRequireSession();
  const info = useSessionInfo();
  return <SettingsLayout scope="Personal settings" title="Account" description="Manage your identity, password, and personal access tokens." links={[{ label: "Account", href: "/account", active: true }, { label: "Notifications", href: "/notifications", active: false }]}>
    {session !== "ok" ? <p role="status">Loading account…</p> : <>
      <section className="ui-card"><h2>Profile</h2><dl className="profile-fields"><div><dt>Username</dt><dd>{info?.user.username ?? "—"}</dd></div><div><dt>Email</dt><dd>{info?.user.email ?? "—"}</dd></div></dl></section>
      <ChangePasswordCard /><PersonalTokensCard open />
    </>}
  </SettingsLayout>;
}
