import { CONNECTOR_ERRORS } from "@/lib/connectors/messages";

/**
 * The Connections screens' calls to the routes under /api/admin/connectors. Every route answers
 * `{ error, message? }` when it refuses, with plain words in `message` for anything about the
 * connection; the few refusals without words get them here. Same origin only: the routes check it.
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; message: string };

export const API_WORDS = {
  network: "YouGrow couldn't be reached. Check your connection and try again.",
  forbidden: "Only admins can do this. Ask an admin on your team.",
  signedOut: "Your session ended. Sign in again.",
  gone: "That connection isn't here any more. Reload the page.",
  invalid: "Something was off with that request. Try again.",
  off: "Connected data is turned off here now. Reload the page.",
  other: "Something went wrong. Try again in a moment.",
} as const;

/** Words for a refusal that came without its own. */
export function refusalWords(status: number, error: string): string {
  if (status === 401) return API_WORDS.signedOut;
  if (status === 403 || error === "forbidden") return API_WORDS.forbidden;
  if (status === 429 || error === "busy") return CONNECTOR_ERRORS.busy;
  if (error === "invalid_input") return API_WORDS.invalid;
  if (error === "connector_off") return API_WORDS.off;
  if (status === 404) return API_WORDS.gone;
  return API_WORDS.other;
}

export async function callApi<T>(url: string, init: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      ...(init.body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, error: "network", message: API_WORDS.network };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, data: body as T };
  const error = typeof body.error === "string" ? body.error : "error";
  const message = typeof body.message === "string" && body.message ? body.message : refusalWords(res.status, error);
  return { ok: false, status: res.status, error, message };
}

const ROOT = "/api/admin/connectors";

/** The route addresses, in one place. */
export const ROUTES = {
  list: ROOT,
  connect: (connectorId: string) => `${ROOT}/${encodeURIComponent(connectorId)}/connect`,
  start: (connectorId: string) => `${ROOT}/${encodeURIComponent(connectorId)}/start`,
  share: (connectorId: string) => `${ROOT}/${encodeURIComponent(connectorId)}/share`,
  connection: (id: string) => `${ROOT}/connections/${encodeURIComponent(id)}`,
  access: (id: string) => `${ROOT}/connections/${encodeURIComponent(id)}/access`,
  accounts: (id: string) => `${ROOT}/connections/${encodeURIComponent(id)}/accounts`,
  check: (id: string) => `${ROOT}/connections/${encodeURIComponent(id)}/check`,
  pause: (id: string) => `${ROOT}/connections/${encodeURIComponent(id)}/pause`,
  grants: (id: string) => `${ROOT}/connections/${encodeURIComponent(id)}/grants`,
} as const;

/** Start Sign in with Google (a new connection, or again for one): the browser goes to Google next. */
export async function startSignIn(connectorId: string, connectionId?: string): Promise<ApiResult<{ url: string }>> {
  const r = await callApi<{ url: string }>(ROUTES.start(connectorId), { method: "POST", body: connectionId ? { connectionId } : {} });
  if (r.ok && (typeof r.data.url !== "string" || !r.data.url.startsWith("https://"))) return { ok: false, status: 502, error: "bad_response", message: API_WORDS.other };
  return r;
}
