import Link from "next/link";
import type { ReactNode } from "react";
import { KeyIcon, ShieldIcon, PeopleIcon, MailIcon, BuildingIcon } from "./icons";
function SettingsIcon({ label }: { label: string }) {
  const Icon = /notification|email/i.test(label) ? MailIcon : /token/i.test(label) ? KeyIcon : /organization/i.test(label) ? BuildingIcon : /account|member/i.test(label) ? PeopleIcon : ShieldIcon;
  return <Icon />;
}
export function SettingsLayout({ scope, title, description, links, children }: {
  scope: string; title: string; description: string; links: { label: string; href?: string; active: boolean; onClick?: () => void }[]; children: ReactNode;
}) {
  return <main className="settings-layout"><aside className="settings-sidebar"><p>{scope}</p><nav aria-label={`${scope} navigation`}>{links.map(link => link.href
    ? <Link key={link.label} href={link.href} aria-current={link.active ? "page" : undefined}><SettingsIcon label={link.label} />{link.label}</Link>
    : <button key={link.label} type="button" aria-current={link.active ? "page" : undefined} onClick={link.onClick}><SettingsIcon label={link.label} />{link.label}</button>)}</nav></aside>
    <div className="settings-content"><header className="page-heading"><p className="ui-eyebrow">{scope}</p><h1>{title}</h1><p className="ui-muted">{description}</p></header>{children}</div></main>;
}
