import { z } from "zod";
import { forTenant, getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import {
  ConnectionCatalogSchema,
  ConsentPolicySchema,
  ProductEnvironment,
  SandboxUserSchema,
  type ProductConnection,
} from "@/lib/types/productConnection";
import { assertSafeHttpsUrl } from "@/lib/security/ssrf";
import { normalizeHost, registrableDomain } from "@/lib/domains/registrableDomain";
import { isAllowedLink, linkDomainOf } from "./links";
import { createConnection, revokeConnection, rotateConnectionSecret } from "./keys";
import { invalidateConnectionCaches } from "./ingestHttp";
import { fetchProductContext, recordContextHealth, type ContextClientDeps } from "./contextClient";
import { sendConnectionWebhook } from "./webhookClient";
import { eraseProductUser } from "./erase";
import {
  SANDBOX_CATALOG,
  SANDBOX_LINK_DOMAINS,
  defaultSandboxUser,
  fireSandboxEvent,
} from "./sandbox";
import { zodReason } from "./protocol";
import { isOwnOrVerifiedAddress } from "@/lib/lifecycle/policy";

/**
 * The Products admin API, as plain functions (status + body) so they're tested
 * against the in-memory Firestore; the route files only gate + parse. Secrets
 * never leave this layer except the one-time reveal on create/rotate.
 */

export type ApiResult = { status: number; body: unknown };
const ok = (body: unknown, status = 200): ApiResult => ({ status, body });
const fail = (status: number, error: string, detail?: string): ApiResult => ({
  status,
  body: detail ? { error, detail } : { error },
});

/** A connection without its sealed secrets. */
export function publicConnection(conn: ProductConnection, nowMs = Date.now()) {
  const { secretEnc: _s, prevSecretEnc: _p, ...rest } = conn;
  return {
    ...rest,
    rotating: Boolean(conn.prevSecretExpiresAt && Date.parse(conn.prevSecretExpiresAt) > nowMs),
  };
}

async function loadConnection(ctx: TenantContext, id: string, db?: FirestoreLike) {
  return forTenant(ctx, db).productConnections.getById(id);
}

// ---- Connections -------------------------------------------------------------------

export async function listConnections(ctx: TenantContext, db?: FirestoreLike): Promise<ApiResult> {
  const all = await forTenant(ctx, db).productConnections.find();
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return ok({ connections: all.map((c) => publicConnection(c)) });
}

const CreateInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["custom", "sandbox"]),
  environment: ProductEnvironment.nullable().optional(),
});

/**
 * Create a connection. A sandbox gets the template catalog, a test user with the
 * admin's own address, and its context/webhook endpoints pointed at the sandbox
 * reference routes. Returns the secret — the only time it is ever shown.
 */
export async function createProductConnection(
  ctx: TenantContext,
  input: unknown,
  opts: { origin: string; db?: FirestoreLike },
): Promise<ApiResult> {
  const parsed = CreateInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const { name, kind, environment } = parsed.data;
  const sandbox = kind === "sandbox";
  const { connection, secret } = await createConnection(
    ctx,
    {
      name,
      kind,
      environment,
      catalog: sandbox ? SANDBOX_CATALOG : undefined,
      sandboxUsers: sandbox && ctx.email ? [defaultSandboxUser(ctx.email)] : [],
      createdBy: ctx.userId ?? null,
    },
    opts.db,
  );
  if (!sandbox) return ok({ connection: publicConnection(connection), secret }, 201);

  const origin = opts.origin.replace(/\/+$/, "");
  const patch = {
    contextEndpoint: { url: `${origin}/api/sandbox/context/${connection.id}`, enabled: true, timeoutMs: 5000 },
    webhookEndpoint: { url: `${origin}/api/sandbox/webhook/${connection.id}`, enabled: true },
    linkDomains: SANDBOX_LINK_DOMAINS,
    updatedAt: new Date().toISOString(),
  };
  await forTenant(ctx, opts.db).productConnections.update(connection.id, patch);
  return ok({ connection: publicConnection({ ...connection, ...patch }), secret }, 201);
}

export async function getConnectionDetail(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ApiResult> {
  const conn = await loadConnection(ctx, id, db);
  if (!conn) return fail(404, "not_found");
  const diagnostics = await forTenant(ctx, db).connectionDiagnostics.getById(id);
  return ok({ connection: publicConnection(conn), diagnostics });
}

const EndpointInput = z.object({
  url: z.string().trim().max(2000),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(500).max(5000).optional(),
});

const PatchInput = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    status: z.enum(["active", "paused"]).optional(),
    environment: ProductEnvironment.nullable().optional(),
    contextEndpoint: EndpointInput.nullable().optional(),
    webhookEndpoint: EndpointInput.omit({ timeoutMs: true }).nullable().optional(),
    linkDomains: z.array(z.string().min(1).max(253)).max(20).optional(),
    signupUrl: z.string().trim().max(2000).nullable().optional(),
    catalog: ConnectionCatalogSchema.optional(),
    consentPolicy: ConsentPolicySchema.optional(),
    defaults: z.object({ timezone: z.string().max(64), locale: z.string().max(16) }).optional(),
  })
  .strict();

/** An endpoint URL a tenant may save: https on 443, not internal (re-checked per call). */
function checkEndpointUrl(url: string): string | null {
  try {
    assertSafeHttpsUrl(url, { allowedPorts: [443] });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "invalid_url";
  }
}

export async function patchConnection(
  ctx: TenantContext,
  id: string,
  input: unknown,
  db?: FirestoreLike,
): Promise<ApiResult> {
  const parsed = PatchInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const conn = await loadConnection(ctx, id, db);
  if (!conn) return fail(404, "not_found");
  if (conn.status === "revoked") return fail(409, "connection_revoked");
  const p = parsed.data;

  if (conn.kind === "sandbox" && (p.contextEndpoint !== undefined || p.webhookEndpoint !== undefined)) {
    return fail(400, "sandbox_endpoints_fixed");
  }
  for (const ep of [p.contextEndpoint, p.webhookEndpoint]) {
    if (ep?.url) {
      const bad = checkEndpointUrl(ep.url);
      if (bad) return fail(400, "invalid_url", bad);
    }
  }
  let linkDomains: string[] | undefined;
  if (p.linkDomains) {
    linkDomains = [];
    for (const d of p.linkDomains) {
      const r = registrableDomain(normalizeHost(d));
      if (!r) return fail(400, "invalid_link_domain", d);
      if (!linkDomains.includes(r)) linkDomains.push(r);
    }
  }

  // Where invited waitlist members sign up (nav v2 phase 4): https, on one of the
  // connection's allowed link domains (the saved ones, or those in this patch).
  let signupUrl: string | null | undefined;
  if (p.signupUrl !== undefined && conn.kind === "custom") {
    if (p.signupUrl === null || p.signupUrl === "") {
      signupUrl = null;
    } else {
      const domain = linkDomainOf(p.signupUrl);
      if (!domain) return fail(400, "invalid_signup_url");
      if (!isAllowedLink(p.signupUrl, linkDomains ?? conn.linkDomains ?? [])) {
        return fail(400, "signup_url_domain_not_allowed", domain);
      }
      signupUrl = p.signupUrl;
    }
  }

  const patch: Partial<ProductConnection> = {
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.status !== undefined ? { status: p.status } : {}),
    ...(p.environment !== undefined && conn.kind === "custom" ? { environment: p.environment } : {}),
    ...(p.contextEndpoint !== undefined
      ? {
          contextEndpoint: p.contextEndpoint
            ? { url: p.contextEndpoint.url, enabled: p.contextEndpoint.enabled, timeoutMs: p.contextEndpoint.timeoutMs ?? 5000 }
            : null,
        }
      : {}),
    ...(p.webhookEndpoint !== undefined ? { webhookEndpoint: p.webhookEndpoint } : {}),
    ...(linkDomains ? { linkDomains } : {}),
    ...(signupUrl !== undefined ? { signupUrl } : {}),
    ...(p.catalog ? { catalog: p.catalog } : {}),
    ...(p.consentPolicy ? { consentPolicy: p.consentPolicy } : {}),
    ...(p.defaults ? { defaults: p.defaults } : {}),
    updatedAt: new Date().toISOString(),
  };
  await forTenant(ctx, db).productConnections.update(id, patch);
  invalidateConnectionCaches(conn.keyId, ctx.tenantId, id);
  return ok({ connection: publicConnection({ ...conn, ...patch }) });
}

export async function revokeProductConnection(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ApiResult> {
  const conn = await loadConnection(ctx, id, db);
  if (!conn) return fail(404, "not_found");
  await revokeConnection(ctx, id, db);
  invalidateConnectionCaches(conn.keyId, ctx.tenantId, id);
  return ok({ ok: true });
}

export async function rotateProductConnectionSecret(
  ctx: TenantContext,
  id: string,
  db?: FirestoreLike,
): Promise<ApiResult> {
  const conn = await loadConnection(ctx, id, db);
  if (!conn) return fail(404, "not_found");
  const rotated = await rotateConnectionSecret(ctx, id, db);
  if (!rotated) return fail(409, "connection_revoked");
  invalidateConnectionCaches(conn.keyId, ctx.tenantId, id);
  return ok({ secret: rotated.secret });
}

// ---- Testing the connection ---------------------------------------------------------

const TestContextInput = z.object({ userId: z.string().min(1).max(256) });

/** "Test connection": pull context for one user and show the validated payload. */
export async function testContext(
  ctx: TenantContext,
  id: string,
  input: unknown,
  opts: { db?: FirestoreLike; client?: ContextClientDeps } = {},
): Promise<ApiResult> {
  const parsed = TestContextInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const conn = await loadConnection(ctx, id, opts.db);
  if (!conn) return fail(404, "not_found");
  const result = await fetchProductContext(
    conn,
    { userId: parsed.data.userId, purpose: "test" },
    { db: opts.db, ...opts.client },
  );
  await recordContextHealth(ctx, conn, result, opts.db);
  return ok(result);
}

export async function testWebhook(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ApiResult> {
  const conn = await loadConnection(ctx, id, db);
  if (!conn) return fail(404, "not_found");
  const result = await sendConnectionWebhook(
    conn,
    { type: "connection.test", data: { message: "Test webhook from YouGrow" } },
    { db },
  );
  return ok(result);
}

// ---- Events and users ----------------------------------------------------------------

const PAGE_MAX = 100;

export async function listConnectionEvents(
  ctx: TenantContext,
  id: string,
  opts: { limit?: number; db?: FirestoreLike } = {},
): Promise<ApiResult> {
  const conn = await loadConnection(ctx, id, opts.db);
  if (!conn) return fail(404, "not_found");
  const repo = forTenant(ctx, opts.db);
  const [events, diagnostics] = await Promise.all([
    repo.productEvents.find({
      where: [["connectionId", "==", id]],
      orderBy: [["receivedAt", "desc"]],
      limit: Math.min(opts.limit ?? 50, PAGE_MAX),
    }),
    repo.connectionDiagnostics.getById(id),
  ]);
  return ok({ events, rejections: diagnostics?.recentRejections ?? [] });
}

export async function listConnectionUsers(
  ctx: TenantContext,
  id: string,
  opts: { limit?: number; after?: string | null; db?: FirestoreLike } = {},
): Promise<ApiResult> {
  const conn = await loadConnection(ctx, id, opts.db);
  if (!conn) return fail(404, "not_found");
  const limit = Math.min(opts.limit ?? 50, PAGE_MAX);
  const users = await forTenant(ctx, opts.db).productUsers.find({
    where: [["connectionId", "==", id]],
    orderBy: [["lastSeenAt", "desc"]],
    ...(opts.after ? { startAfter: [opts.after] } : {}),
    limit,
  });
  const next = users.length === limit ? (users[users.length - 1]?.lastSeenAt ?? null) : null;
  return ok({ users, next });
}

export async function eraseConnectionUser(
  ctx: TenantContext,
  id: string,
  productUserId: string,
  db?: FirestoreLike,
): Promise<ApiResult> {
  const erased = await eraseProductUser(ctx, id, productUserId, db);
  return erased ? ok({ ok: true }) : fail(404, "not_found");
}

// ---- Sandbox ----------------------------------------------------------------------------

const SandboxUsersInput = z.object({ users: z.array(SandboxUserSchema).max(10) });

/**
 * Replace the sandbox's test users. Their addresses are limited to the admin's
 * own sign-in address or the tenant's VERIFIED sending domains, so a sandbox can
 * never be used to email arbitrary people.
 */
export async function putSandboxUsers(
  ctx: TenantContext,
  id: string,
  input: unknown,
  db?: FirestoreLike,
): Promise<ApiResult> {
  const parsed = SandboxUsersInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const conn = await loadConnection(ctx, id, db);
  if (!conn) return fail(404, "not_found");
  if (conn.kind !== "sandbox" || !conn.sandbox) return fail(400, "not_a_sandbox");

  const tenant = await getTenantById(ctx.tenantId, db).catch(() => null);
  for (const u of parsed.data.users) {
    if (!isOwnOrVerifiedAddress(u.email, { ownEmail: ctx.email, tenant })) {
      return fail(400, "recipient_not_allowed", u.email);
    }
  }
  const ids = new Set<string>();
  for (const u of parsed.data.users) {
    if (ids.has(u.userId)) return fail(400, "duplicate_user_id", u.userId);
    ids.add(u.userId);
  }
  await forTenant(ctx, db).productConnections.update(id, {
    sandbox: { ...conn.sandbox, users: parsed.data.users },
    updatedAt: new Date().toISOString(),
  });
  return ok({ users: parsed.data.users });
}

const FireInput = z.object({
  userId: z.string().min(1).max(256),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("identify") }),
    z.object({ kind: z.literal("signed_up") }),
    z.object({ kind: z.literal("step"), step: z.string().min(1).max(64) }),
    z.object({ kind: z.literal("completed") }),
    z.object({
      kind: z.literal("preferences"),
      category: z.string().min(1).max(64),
      subscribed: z.boolean(),
    }),
    z.object({ kind: z.literal("deleted") }),
  ]),
});

/** Act as the sandbox product: send events for a test user through real ingest. */
export async function fireSandbox(
  ctx: TenantContext,
  id: string,
  input: unknown,
  opts: { origin: string; db?: FirestoreLike },
): Promise<ApiResult> {
  const parsed = FireInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const conn = await loadConnection(ctx, id, opts.db);
  if (!conn) return fail(404, "not_found");
  if (conn.kind !== "sandbox") return fail(400, "not_a_sandbox");
  const r = await fireSandboxEvent(ctx, conn, parsed.data.userId, parsed.data.action, {
    db: opts.db,
    origin: opts.origin,
  });
  return { status: r.status === 202 ? 200 : r.status, body: r.body };
}
