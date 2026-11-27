import { api, type ApiResponse } from "@/components/admin/connect/api";
import { WORK_MESSAGES } from "@/lib/work/words";

/**
 * Calls to Work's admin routes from its screens (/api/admin/work/*). The routes check the origin,
 * the switch, the session and every field; a refusal carries the words a person reads.
 */

export type WorkAnswer<T> = ApiResponse<T & { error?: string; message?: string; issues?: Array<{ path: string; message: string }> }>;

export async function workCall<T = Record<string, unknown>>(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<WorkAnswer<T>> {
  return api<T & { error?: string; message?: string }>(`/api/admin/work${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** What went wrong, in words: the route's own message, else the refusal's, else a plain retry. */
export function workErrorText(data: unknown): string {
  const d = (data ?? {}) as { error?: string; message?: string };
  if (d.message) return d.message;
  if (d.error === "network") return "Couldn't reach YouGrow. Check your connection and try again.";
  if (d.error === "unauthorized") return "You're signed out. Sign in again, then try again.";
  if (d.error === "not_found") return WORK_MESSAGES.not_found;
  if (d.error && Object.hasOwn(WORK_MESSAGES, d.error)) return WORK_MESSAGES[d.error as keyof typeof WORK_MESSAGES];
  return "That didn't work. Try again in a minute.";
}
