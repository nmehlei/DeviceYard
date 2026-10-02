"use client";
import { useState } from "react";
import { CopyIcon } from "./icons";

/** A <pre> block with a copy button, factored out of the copy-to-clipboard
 * pattern PersonalTokensCard.tsx already has (try navigator.clipboard,
 * "Copied" on success for 1.5s, a visible error on failure) - the MCP setup
 * page needs the same behaviour on five separate snippets, and duplicating
 * the try/catch and timeout per block would drift out of sync with the
 * original the first time one of them changes. */
export function CopyableCode({ code, ariaLabel }: { code: string; ariaLabel: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  const onCopy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard API unavailable");
      await navigator.clipboard.writeText(code);
      setError(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(true);
    }
  };

  return (
    <div className="relative">
      <pre className="mono overflow-x-auto rounded-md border border-(--border) bg-(--background) p-3 pr-16 text-xs text-(--foreground)">
        {code}
      </pre>
      <button
        onClick={onCopy}
        aria-label={ariaLabel}
        className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-(--border) bg-(--surface) px-2 py-1 text-xs text-(--muted) hover:text-(--foreground)"
      >
        <CopyIcon />
        {copied ? "Copied" : "Copy"}
      </button>
      {error && <p className="mt-1 text-xs text-(--status-failed)">failed to copy to clipboard</p>}
    </div>
  );
}
