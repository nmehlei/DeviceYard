"use client";
import { useState } from "react";
import { login, ApiError } from "../../lib/api";
import { navigate } from "../../lib/navigate";
import Link from "next/link";
import { Brand } from "../../components/Brand";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await login(username, password);
      const returnTo = new URLSearchParams(window.location.search).get("returnTo");
      navigate(returnTo?.startsWith("/notification-run?") ? returnTo : "/");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "That username or password was not accepted."
          : "Sign-in failed - try again."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-(--background)">
      <form onSubmit={onSubmit} className="w-80 rounded-lg border border-(--border) bg-(--surface) p-6">
        <h1 className="mb-6"><Brand size={48} /></h1>

        <label htmlFor="username" className="mb-1 block text-sm text-(--muted)">
          Username
        </label>
        <input
          id="username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mb-3 w-full rounded border border-(--border) bg-(--background) px-3 py-2 text-(--foreground)"
          autoFocus
        />

        <label htmlFor="password" className="mb-1 block text-sm text-(--muted)">
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-3 w-full rounded border border-(--border) bg-(--background) px-3 py-2 text-(--foreground)"
        />

        {error && <p className="mb-3 text-sm text-(--status-failed)">{error}</p>}

        <button
          type="submit"
          disabled={submitting || username.length === 0 || password.length === 0}
          className="w-full rounded bg-(--status-running) px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Sign in
        </button>
        <Link href="/reset-password" className="mt-4 block text-center text-sm text-(--status-running)">Forgot password?</Link>
      </form>
    </main>
  );
}
