import { isRateLimited, type RateLimitConfig, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import { readRequestTextCapped } from "@/lib/http/readBody";
import { parseBasicAuth, resolveConnection, secretMatches } from "../connectionAuth";
import { environmentOf } from "../environments";
import { BatchRequestSchema, EventRequestSchema, fieldErrors, parseUserPatch, UserIdSchema, V2_LIMITS, type MeResponse } from "./contract";
import { isApiV2Enabled } from "./flags";
import { deleteUser, getUserView, patchBatch, patchUser, recordUserEvent } from "./users";

/**
 * The HTTP side of API v2 (`/api/v2/users…`). Server-to-server only (no CORS).
 * Every request goes through the same gate, in this order:
 *
 *  1. the flag (404 while API v2 is off);
 *  2. a size-capped body read (413);
 *  3. HTTP Basic auth — key id → tenant + connection, secret checked in
 *     constant time against the current (or rotating-out) secret (401);
 *  4. THEN the per-key rate limit, so a bad secret never burns a real key's
 *     quota (429 + Retry-After);
 *  5. JSON + schema validation (400 naming the field), then the operation.
 */

export interface V2HttpDeps {
  db?: FirestoreLike;
  nowMs?: () => number;
  /** Override the durable rate limiter (tests). */
  rateLimit?: (keyId: string) => Promise<boolean>;
}

/** Per key: 600 requests a minute, 20,000 an hour. A batch of up to 100 users counts once. */
export const API_V2_RATE_LIMIT: RateLimitConfig = {
  prefix: "api_v2",
  burstLimit: 600,
  hourlyLimit: 20_000,
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

const unauthorized = () =>
  json(401, { error: "unauthorized", message: "Use HTTP Basic auth: your key id as the username, your secret as the password." }, {
    "www-authenticate": 'Basic realm="YouGrow API", charset="UTF-8"',
  });

type Gate =
  | { ok: true; ctx: TenantContext; connection: ProductConnection; body: string; nowMs: number }
  | { ok: false; response: Response };

async function gate(req: Request, deps: V2HttpDeps, readBody: boolean): Promise<Gate> {
  // Its own code, so a client can't mistake "the API is off here" for "no such user".
  if (!isApiV2Enabled()) return { ok: false, response: json(404, { error: "api_disabled", message: "API v2 isn't enabled on this YouGrow." }) };
  const nowMs = (deps.nowMs ?? Date.now)();
  let body = "";
  if (readBody) {
    const raw = await readRequestTextCapped(req, V2_LIMITS.maxBodyBytes);
    if (raw === null) return { ok: false, response: json(413, { error: "body_too_large", message: `At most ${V2_LIMITS.maxBodyBytes / 1024} KB.` }) };
    body = raw;
  }
  const creds = parseBasicAuth(req.headers.get("authorization"));
  if (!creds) return { ok: false, response: unauthorized() };
  let ctx: TenantContext;
  let connection: ProductConnection;
  try {
    const resolved = await resolveConnection(creds.keyId, nowMs, deps.db);
    if (!resolved) return { ok: false, response: unauthorized() };
    ({ ctx, connection } = resolved);
    if (!secretMatches(connection, creds.secret, nowMs)) return { ok: false, response: unauthorized() };
  } catch (err) {
    console.error(`[api-v2] auth unavailable: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    return { ok: false, response: json(503, { error: "unavailable" }, { "retry-after": "5" }) };
  }
  const limited = deps.rateLimit ?? ((k: string) => isRateLimited(k, API_V2_RATE_LIMIT, { db: deps.db, now: nowMs }));
  if (await limited(creds.keyId)) return { ok: false, response: json(429, { error: "rate_limited" }, { "retry-after": "60" }) };
  return { ok: true, ctx, connection, body, nowMs };
}

function parseJson(body: string): { ok: true; value: unknown } | { ok: false; response: Response } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false, response: json(400, { error: "invalid_json" }) };
  }
}

function checkUserId(userId: string): Response | null {
  const r = UserIdSchema.safeParse(userId);
  return r.success ? null : json(400, { error: "invalid", fields: fieldErrors(r.error).map((f) => ({ ...f, path: "userId" })) });
}

/** Unexpected failures: safe to retry, since every write is idempotent. */
function internal(scope: string, err: unknown): Response {
  console.error(`[api-v2] ${scope} failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
  return json(500, { error: "internal" });
}

export async function handlePatchUser(req: Request, userId: string, deps: V2HttpDeps = {}): Promise<Response> {
  const g = await gate(req, deps, true);
  if (!g.ok) return g.response;
  const bad = checkUserId(userId);
  if (bad) return bad;
  const body = parseJson(g.body);
  if (!body.ok) return body.response;
  // Invalid profile fields are dropped (and reported); anything else invalid is a 400.
  const parsed = parseUserPatch(body.value);
  if (!parsed.ok) return json(400, { error: "invalid", fields: parsed.fields });
  try {
    const r = await patchUser(g.ctx, g.connection, userId, parsed.patch, { db: deps.db, nowMs: g.nowMs });
    if ("invalid" in r) return json(400, { error: "invalid", fields: r.invalid });
    return json(200, r.applied && parsed.ignoredFields.length ? { ...r, ignoredFields: parsed.ignoredFields } : r);
  } catch (err) {
    return internal("patch", err);
  }
}

/** GET /api/v2/me — the connection behind the key: a credential check that also names the environment. */
export async function handleMe(req: Request, deps: V2HttpDeps = {}): Promise<Response> {
  const g = await gate(req, deps, false);
  if (!g.ok) return g.response;
  const c = g.connection;
  const me: MeResponse = {
    connection: { id: c.id, name: c.name, environment: environmentOf(c), status: c.status },
    keyId: c.keyId,
    rotating: Boolean(c.prevSecretExpiresAt && Date.parse(c.prevSecretExpiresAt) > g.nowMs),
  };
  return json(200, me);
}

export async function handleGetUser(req: Request, userId: string, deps: V2HttpDeps = {}): Promise<Response> {
  const g = await gate(req, deps, false);
  if (!g.ok) return g.response;
  const bad = checkUserId(userId);
  if (bad) return bad;
  try {
    const view = await getUserView(g.ctx, g.connection, userId, { db: deps.db, nowMs: g.nowMs });
    return view ? json(200, view) : json(404, { error: "not_found" });
  } catch (err) {
    return internal("get", err);
  }
}

export async function handleDeleteUser(req: Request, userId: string, deps: V2HttpDeps = {}): Promise<Response> {
  const g = await gate(req, deps, false);
  if (!g.ok) return g.response;
  const bad = checkUserId(userId);
  if (bad) return bad;
  try {
    await deleteUser(g.ctx, g.connection, userId, { db: deps.db, nowMs: g.nowMs });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return internal("delete", err);
  }
}

export async function handleBatch(req: Request, deps: V2HttpDeps = {}): Promise<Response> {
  const g = await gate(req, deps, true);
  if (!g.ok) return g.response;
  const body = parseJson(g.body);
  if (!body.ok) return body.response;
  const parsed = BatchRequestSchema.safeParse(body.value);
  if (!parsed.success) return json(400, { error: "invalid", fields: fieldErrors(parsed.error) });
  try {
    return json(200, await patchBatch(g.ctx, g.connection, parsed.data.users, { db: deps.db, nowMs: g.nowMs }));
  } catch (err) {
    return internal("batch", err);
  }
}

export async function handleUserEvent(req: Request, userId: string, deps: V2HttpDeps = {}): Promise<Response> {
  const g = await gate(req, deps, true);
  if (!g.ok) return g.response;
  const bad = checkUserId(userId);
  if (bad) return bad;
  const body = parseJson(g.body);
  if (!body.ok) return body.response;
  const parsed = EventRequestSchema.safeParse(body.value);
  if (!parsed.success) return json(400, { error: "invalid", fields: fieldErrors(parsed.error) });
  const props = JSON.stringify(parsed.data.properties ?? {});
  if (Buffer.byteLength(props, "utf8") > V2_LIMITS.maxPropertiesBytes) {
    return json(400, { error: "invalid", fields: [{ path: "properties", message: `at most ${V2_LIMITS.maxPropertiesBytes / 1024} KB` }] });
  }
  try {
    const r = await recordUserEvent(g.ctx, g.connection, userId, parsed.data, { db: deps.db, nowMs: g.nowMs });
    return "notFound" in r ? json(404, { error: "not_found", message: "Send the user's state with PATCH first." }) : json(200, r);
  } catch (err) {
    return internal("event", err);
  }
}
