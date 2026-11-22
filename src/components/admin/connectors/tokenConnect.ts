import type { ConnectionView } from "@/lib/connectors/service";
import { callApi, ROUTES, type ApiResult } from "./api";
import { LISTING_COPY, grantsLostWords } from "./words";

/** The screens' call to a route; tests pass their own. */
export type ApiCall = <T>(url: string, init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown }) => Promise<ApiResult<T>>;

export type TokenConnectOutcome =
  /** Connected, with who could read the old connection carried over. */
  | { kind: "connected" }
  /** Nothing new was connected: say why, and stay on the page so the next try keeps the grants. */
  | { kind: "refused"; message: string }
  /** Connected, but who can read it didn't carry over: say what to tick again on Connected. */
  | { kind: "grantsLost"; message: string };

/**
 * Connect with a pasted token, or Reconnect a connection whose token was turned down. The brand
 * can't hold two connections to one account, so a Reconnect disconnects the old one first (again
 * is harmless: a disconnected connection answers as before), then connects with the new token and
 * gives the new connection the old one's grants. The grants come from the page, so a failed try
 * keeps them for the next one; a failed grants call is said, never swallowed.
 */
export async function connectWithToken(
  connectorId: string,
  fields: Record<string, string>,
  replace: ConnectionView | null,
  chat: boolean,
  call: ApiCall = callApi,
): Promise<TokenConnectOutcome> {
  if (replace) {
    const gone = await call(ROUTES.connection(replace.id), { method: "DELETE" });
    if (!gone.ok && gone.status !== 404) return { kind: "refused", message: gone.message };
  }
  const made = await call<ConnectionView>(ROUTES.connect(connectorId), { method: "POST", body: { fields } });
  if (!made.ok) return { kind: "refused", message: replace ? `${made.message} ${LISTING_COPY.tokenRetry}` : made.message };
  const grants = replace?.details?.grants ?? [];
  if (!grants.length) return { kind: "connected" };
  const kept = await call(ROUTES.grants(made.data.id), { method: "PUT", body: { grants } });
  if (kept.ok) return { kind: "connected" };
  const lost = grantsLostWords(grants, chat);
  return lost ? { kind: "grantsLost", message: lost } : { kind: "connected" };
}
