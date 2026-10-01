// Shared small (12x12) button icons for the admin/org-settings cards -
// same hand-rolled stroke-svg style as NavBar's icons, pulled into one
// place since these five buttons (Create/Rename/Save/Archive/Remove/
// Toggle-admin/Reset-password/Reveal/Revoke) are reused across
// AdminOrgsCard, AdminUsersCard, OrgMembersCard, and OrgTokensCard.

export function PeopleIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.3" /><path d="M1.5 14v-1.5a4.5 4.5 0 0 1 9 0V14M11 3a2.5 2.5 0 0 1 0 5M12 10a3 3 0 0 1 2.5 3v1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}
export function BuildingIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 14V2h7v12M10 6h3v8M1 14h14M5 5h3M5 8h3M6 14v-3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>;
}
export function MailIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" /><path d="m2 4 6 5 6-5" stroke="currentColor" strokeWidth="1.3" /></svg>;
}
export function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M7.9 1.8 10.2 4.1 3.9 10.4 1.2 10.8 1.6 8.1 7.9 1.8Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 6.3 4.8 9 10 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArchiveIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="1.2" y="1.8" width="9.6" height="2.4" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 4.4v5.1a.7.7 0 0 0 .7.7h6.6a.7.7 0 0 0 .7-.7V4.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.8 6.6h2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 3.4h8M4.4 3.4V2.1h3.2v1.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M2.9 3.4 3.4 9.8a.9.9 0 0 0 .9.8h3.4a.9.9 0 0 0 .9-.8l.5-6.4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function ShieldIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 1.3 9.8 2.8v2.8c0 2.5-1.6 4.5-3.8 5.1-2.2-.6-3.8-2.6-3.8-5.1V2.8L6 1.3Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function KeyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="3.6" cy="6" r="2.1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.5 6h5M8.3 6v2M10 6v1.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M1 6s1.8-3.2 5-3.2S11 6 11 6s-1.8 3.2-5 3.2S1 6 1 6Z" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="6" cy="6" r="1.3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function EyeOffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M1 6s1.8-3.2 5-3.2S11 6 11 6s-1.8 3.2-5 3.2S1 6 1 6Z" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="6" cy="6" r="1.3" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 1.5l9 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="4.4" y="4.4" width="6.2" height="6.2" rx="0.6" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2.8 7.6H2.2a.6.6 0 0 1-.6-.6V2.2a.6.6 0 0 1 .6-.6H7a.6.6 0 0 1 .6.6v.6" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

/** Sliders rather than a cog: this opens a settings form, not a menu. */
export function SlidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4.5h5M11 4.5h3M2 11.5h3M9 11.5h5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="9" cy="4.5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="7" cy="11.5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
