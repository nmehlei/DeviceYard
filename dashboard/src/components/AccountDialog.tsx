"use client";
import { useEffect, useRef } from "react";
import { ChangePasswordCard } from "./ChangePasswordCard";
import PersonalTokensCard from "./PersonalTokensCard";

/** Native <dialog>, not a hand-rolled overlay - showModal()/close() give a
 * real focus trap, Escape-to-close, and top-layer stacking for free, and
 * this app otherwise avoids adding UI dependencies. Driven by open/onClose
 * props rather than the element's own `open` attribute: React's boolean
 * `open` renders a plain non-modal <dialog> (no backdrop, no focus trap) -
 * only the imperative showModal()/close() calls get the modal behavior.
 *
 * Named (and reachable) as account-level settings, not password-specific:
 * it holds both ChangePasswordCard and PersonalTokensCard, and a PAT is
 * account-wide, not tied to changing a password. This dialog carries its
 * own "Account settings" heading above the two cards' own headings so the
 * NavBar item that opens it can name what's actually inside.
 *
 * Known gap, deliberately deferred rather than fixed here: Escape closes
 * this dialog (native <dialog> behavior) even mid-revoke-confirmation in
 * PersonalTokensCard, discarding that confirmation with no warning. */
export function AccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    // Border/background/rounding come from ChangePasswordCard itself (it's
    // meant to look like a card either standalone or here) - this element
    // supplies only sizing and the backdrop, so there is one visible surface
    // instead of a card nested inside another bordered box.
    //
    // m-auto is load-bearing, not decorative: dialog:modal centers itself
    // via the UA stylesheet's `margin: auto` (confirmed via
    // getComputedStyle - position:fixed/inset:0 both apply correctly on
    // their own), but Tailwind's preflight resets margin to 0 on every
    // element, which silently wins over that UA default and pins the
    // dialog to the top-left corner instead of centering it. m-auto
    // re-asserts the centering explicitly rather than relying on it.
    <dialog ref={ref} onClose={onClose} className="m-auto w-full max-w-xl bg-transparent p-0 backdrop:bg-black/50">
      <div className="relative flex flex-col gap-4">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 text-(--muted) hover:text-(--foreground)"
        >
          ✕
        </button>
        <h2 className="text-sm font-semibold text-(--foreground)">Account settings</h2>
        <ChangePasswordCard />
        <PersonalTokensCard open={open} />
      </div>
    </dialog>
  );
}
