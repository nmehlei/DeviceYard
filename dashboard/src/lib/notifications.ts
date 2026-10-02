import { ApiError } from "./api";
export type RunPreference = "off" | "failures" | "all";
export interface Preferences { email: string; verified: boolean; isAdmin: boolean; available: boolean; orgs: { orgId: number; orgName: string; run: RunPreference }[]; deviceHealth: boolean }
export interface Preview { subject: string; html: string; text: string }
export interface Invitation { id: string; email: string; expiresAt: number; status: string }
export async function notificationRequest<T>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(url, { method, credentials: "include", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new ApiError(res.status, error.error || "Request failed. Please try again.");
  }
  return res.status === 204 ? undefined as T : res.json();
}
