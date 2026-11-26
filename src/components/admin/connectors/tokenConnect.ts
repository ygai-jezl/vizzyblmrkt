import type { ConnectorAccount } from "@/lib/connectors/handlers/types";
import type { ConnectionView, TokenCheck } from "@/lib/connectors/service";
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

/** The most a connection's label may hold (the connect route's limit). */
const LABEL_MAX = 60;

/**
 * Connect with a pasted token, or Reconnect a connection whose token was turned down. The brand
 * can't hold two connections to one account, so a Reconnect disconnects the old one first (again
 * is harmless: a disconnected connection answers as before), then connects with the new token and
 * gives the new connection the old one's grants. The grants come from the page, so a failed try
 * keeps them for the next one; a failed grants call is said, never swallowed. `label` names the
 * connection, such as the zone picked after Check (acme.example), so Connected and Disconnect can.
 *
 * `inPlace` (an MCP server's key, ADR-0019, whose account comes from the key): the server checks
 * the new key against the connection's own account first and only then swaps the sealed key, so
 * nothing is disconnected or erased, its grants and collected numbers stay, and a key for another
 * account is refused in plain words with nothing changed.
 */
export async function connectWithToken(
  connectorId: string,
  fields: Record<string, string>,
  replace: ConnectionView | null,
  chat: boolean,
  call: ApiCall = callApi,
  label?: string,
  inPlace = false,
): Promise<TokenConnectOutcome> {
  if (replace && inPlace) {
    const swapped = await call<ConnectionView>(ROUTES.connect(connectorId), { method: "POST", body: { fields, replace: replace.id } });
    return swapped.ok ? { kind: "connected" } : { kind: "refused", message: swapped.message };
  }
  if (replace) {
    const gone = await call(ROUTES.connection(replace.id), { method: "DELETE" });
    if (!gone.ok && gone.status !== 404) return { kind: "refused", message: gone.message };
  }
  const named = label?.trim().slice(0, LABEL_MAX);
  const made = await call<ConnectionView>(ROUTES.connect(connectorId), { method: "POST", body: { fields, ...(named ? { label: named } : {}) } });
  if (!made.ok) return { kind: "refused", message: replace ? `${made.message} ${LISTING_COPY.tokenRetry}` : made.message };
  const grants = replace?.details?.grants ?? [];
  if (!grants.length) return { kind: "connected" };
  const kept = await call(ROUTES.grants(made.data.id), { method: "PUT", body: { grants } });
  if (kept.ok) return { kind: "connected" };
  const lost = grantsLostWords(grants, chat);
  return lost ? { kind: "grantsLost", message: lost } : { kind: "connected" };
}

export type TokenCheckOutcome =
  /** The token works and lists what it can see: pick one. */
  | { kind: "listed"; accounts: ConnectorAccount[]; more: boolean }
  /** The token can't list them: type the account instead, and Connect checks the token with it. */
  | { kind: "typed" }
  /** The token was turned down, or the check didn't go through: say why. */
  | { kind: "refused"; message: string }
  /** The token in the form changed while Check ran: the answer is for another token, so drop it. */
  | { kind: "stale" };

/** The secret fields of a token form, as Check sends them. */
export function secretsOf(fields: ReadonlyArray<{ key: string; secret: boolean }>, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(fields.filter((f) => f.secret).map((f) => [f.key, values[f.key] ?? ""]));
}

const sameSecrets = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/**
 * Check a pasted token before connecting (Check on a token Listing that picks from a list). Only
 * the secret fields go; the route saves nothing. `current` reads the form's secrets when the answer
 * comes: one edited while Check ran gets no answer, so a token is never shown as checked, with the
 * zones another token can see, when it wasn't the one checked.
 */
export async function checkPastedToken(
  connectorId: string,
  secrets: Record<string, string>,
  call: ApiCall = callApi,
  current?: () => Record<string, string>,
): Promise<TokenCheckOutcome> {
  const r = await call<TokenCheck>(ROUTES.checkToken(connectorId), { method: "POST", body: { fields: secrets } });
  if (current && !sameSecrets(secrets, current())) return { kind: "stale" };
  if (!r.ok) return { kind: "refused", message: r.message };
  return r.data.listed && r.data.accounts.length ? { kind: "listed", accounts: r.data.accounts, more: r.data.more } : { kind: "typed" };
}
