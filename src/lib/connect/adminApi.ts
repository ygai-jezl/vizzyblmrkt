import { randomUUID } from "node:crypto";
import { z } from "zod";
import { forTenant, getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import {
  ConnectionCatalogSchema,
  ConsentPolicySchema,
  ENTITY_KIND_RE,
  ProductEnvironment,
  SandboxUserSchema,
  type ConnectionCatalog,
  type ProductConnection,
} from "@/lib/types/productConnection";
import { assertSafeHttpsUrl } from "@/lib/security/ssrf";
import { normalizeHost, registrableDomain } from "@/lib/domains/registrableDomain";
import { isAllowedLink, linkDomainOf } from "./links";
import { createConnection, revokeConnection, rotateConnectionSecret } from "./keys";
import { invalidateConnectionCaches } from "./connectionAuth";
import { fetchProductContext, recordContextHealth, type ContextClientDeps } from "./contextClient";
import { sendConnectionWebhook } from "./webhookClient";
import { eraseProductUser } from "./erase";
import { productUserDocId } from "./profile";
import { stepPlacement } from "./stepPlacement";
import { getUserView } from "./v2/users";
import { isCatalogHistoryEnabled, isDateFactsEnabled, isEntitiesEnabled } from "./v2/flags";
import { getCatalogRevision, listCatalogRevisions, recordCatalogRevision } from "./catalogHistory";
import {
  SANDBOX_CATALOG,
  SANDBOX_LINK_DOMAINS,
  defaultSandboxUser,
  fireSandboxEvent,
} from "./sandbox";
import { zodReason } from "./protocol";
import { ENTITY_ID_RE } from "./v2/contract";
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
    catalogRev: conn.catalogRev ?? 0,
    rotating: Boolean(conn.prevSecretExpiresAt && Date.parse(conn.prevSecretExpiresAt) > nowMs),
  };
}

async function loadConnection(ctx: TenantContext, id: string, db?: FirestoreLike) {
  return forTenant(ctx, db).productConnections.getById(id);
}

/** Whether the connection's catalog already holds this fact as a date (a save may keep what's there). */
function wasDate(conn: ProductConnection, factId: string): boolean {
  return (conn.catalog.facts ?? []).some((f) => f.id === factId && f.type === "date");
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
  return ok({
    connection: publicConnection(conn),
    diagnostics,
    features: { entities: isEntitiesEnabled(), catalogHistory: isCatalogHistoryEnabled(), dateFacts: isDateFactsEnabled() },
  });
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
    /** With `catalog`: the catalogRev it was edited from. A save from an older copy is refused. */
    catalogRev: z.number().int().min(0).optional(),
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
  // A catalog save must say which version it was edited from. A page loaded before this check
  // existed doesn't, and shows the detail as is (it doesn't know the code).
  if (p.catalog && p.catalogRev === undefined) return fail(409, "catalog_page_outdated", "reload the page, then save again");
  // Date facts are behind their own switch: where it's off no catalog holds one, so nothing downstream reads one.
  if (p.catalog && !isDateFactsEnabled() && p.catalog.facts.some((f) => f.type === "date" && !wasDate(conn, f.id))) {
    return fail(400, "date_facts_unavailable");
  }

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
    ...(p.consentPolicy ? { consentPolicy: p.consentPolicy } : {}),
    ...(p.defaults ? { defaults: p.defaults } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (!p.catalog) {
    await forTenant(ctx, db).productConnections.update(id, patch);
    invalidateConnectionCaches(conn.keyId, ctx.tenantId, id);
    return ok({ connection: publicConnection({ ...conn, ...patch }) });
  }
  const r = await writeCatalog(ctx, id, { catalog: p.catalog, baseRev: p.catalogRev ?? 0, patch, source: "editor" }, db);
  return r.ok ? ok({ connection: publicConnection(r.connection) }) : r.result;
}

/**
 * Replace a connection's catalog — only if it's still the version the change was
 * made from (checked and written in one transaction), bumping catalogRev and
 * recording the version in the catalog history. When it isn't, 409
 * `catalog_changed` carries the current catalog so the page can carry its edits
 * over onto it.
 */
async function writeCatalog(
  ctx: TenantContext,
  id: string,
  change: {
    catalog: ConnectionCatalog;
    baseRev: number;
    patch: Partial<ProductConnection>;
    source: "editor" | "restore";
    restoredFrom?: number;
  },
  db?: FirestoreLike,
): Promise<{ ok: true; connection: ProductConnection } | { ok: false; result: ApiResult }> {
  const seen: { before?: ProductConnection; conflict?: ProductConnection } = {};
  const saved = await forTenant(ctx, db).productConnections.claim(id, (current) => {
    seen.conflict = undefined;
    seen.before = current;
    if (current.status === "revoked") return null;
    if ((current.catalogRev ?? 0) !== change.baseRev) {
      seen.conflict = current;
      return null;
    }
    return { ...change.patch, catalog: change.catalog, catalogRev: change.baseRev + 1 };
  });
  if (seen.conflict) {
    const c = seen.conflict;
    return { ok: false, result: { status: 409, body: { error: "catalog_changed", catalog: c.catalog, catalogRev: c.catalogRev ?? 0, updatedAt: c.updatedAt } } };
  }
  if (!saved || !seen.before) return { ok: false, result: seen.before ? fail(409, "connection_revoked") : fail(404, "not_found") };
  invalidateConnectionCaches(saved.keyId, ctx.tenantId, id);
  await recordCatalogRevision(
    ctx,
    {
      connectionId: id,
      before: { catalog: seen.before.catalog, rev: change.baseRev, savedAt: seen.before.updatedAt },
      after: { catalog: saved.catalog, rev: change.baseRev + 1 },
      source: change.source,
      ...(change.restoredFrom !== undefined ? { restoredFrom: change.restoredFrom } : {}),
      nowIso: saved.updatedAt,
    },
    db,
  );
  return { ok: true, connection: saved };
}

// ---- Catalog history ------------------------------------------------------------------

/** The catalog's kept versions, newest first — what changed, who and when (not the catalogs themselves). */
export async function getCatalogHistory(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ApiResult> {
  if (!isCatalogHistoryEnabled()) return fail(404, "not_found");
  const conn = await loadConnection(ctx, id, db);
  if (!conn) return fail(404, "not_found");
  const rows = await listCatalogRevisions(ctx, id, db);
  return ok({
    catalogRev: conn.catalogRev ?? 0,
    versions: rows.map((r) => ({
      rev: r.rev,
      savedAt: r.savedAt,
      savedBy: r.savedBy,
      source: r.source,
      restoredFrom: r.restoredFrom ?? null,
      changes: r.changes,
    })),
  });
}

const RestoreInput = z.object({ catalogRev: z.number().int().min(0) });

/** Bring back an earlier version as a new one — refused, like a save, when the page's copy is out of date. */
export async function restoreCatalogVersion(
  ctx: TenantContext,
  id: string,
  rev: number,
  input: unknown,
  db?: FirestoreLike,
): Promise<ApiResult> {
  if (!isCatalogHistoryEnabled()) return fail(404, "not_found");
  const parsed = RestoreInput.safeParse(input);
  if (!parsed.success || !Number.isInteger(rev) || rev < 0) return fail(400, "invalid_input", parsed.success ? "rev" : zodReason(parsed.error));
  const conn = await loadConnection(ctx, id, db);
  if (!conn) return fail(404, "not_found");
  if (conn.status === "revoked") return fail(409, "connection_revoked");
  const version = await getCatalogRevision(ctx, id, rev, db);
  if (!version) return fail(404, "version_not_found");
  const catalog = ConnectionCatalogSchema.safeParse(version.catalog);
  if (!catalog.success) return fail(422, "catalog_invalid", zodReason(catalog.error));
  const r = await writeCatalog(
    ctx,
    id,
    { catalog: catalog.data, baseRev: parsed.data.catalogRev, patch: { updatedAt: new Date().toISOString() }, source: "restore", restoredFrom: rev },
    db,
  );
  return r.ok ? ok({ connection: publicConnection(r.connection) }) : r.result;
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

const TestContextInput = z.object({
  userId: z.string().min(1).max(256),
  /** Ask about one of the user's things (e.g. a brand), as a send about it would. */
  entity: z.object({ id: z.string().regex(ENTITY_ID_RE), kind: z.string().regex(ENTITY_KIND_RE) }).nullable().optional(),
});

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
  const { userId, entity } = parsed.data;
  const [result, user] = await Promise.all([
    fetchProductContext(conn, { userId, purpose: "test", ...(entity ? { entity } : {}) }, { db: opts.db, ...opts.client }),
    forTenant(ctx, opts.db).productUsers.getById(productUserDocId(conn.id, userId)),
  ]);
  await recordContextHealth(ctx, conn, result, opts.db);
  // The things we hold for this user, to pick one to test for.
  const entities =
    user && user.connectionId === conn.id && user.status === "active"
      ? Object.entries(user.entities ?? {}).map(([id, e]) => ({ id, kind: e.kind, name: e.name }))
      : [];
  return ok({ ...result, entities });
}

/** What an endpoint that's still starting up answers: the test tries once more, as a delivery would. */
const STARTING_UP = new Set(["timeout", "http_502", "http_503", "http_504"]);

export async function testWebhook(
  ctx: TenantContext,
  id: string,
  db?: FirestoreLike,
  deps: Pick<NonNullable<Parameters<typeof sendConnectionWebhook>[2]>, "fetchImpl"> = {},
): Promise<ApiResult> {
  const conn = await loadConnection(ctx, id, db);
  if (!conn) return fail(404, "not_found");
  // Both tries carry the same id, like a delivery's retries.
  const event = {
    id: `wh_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    type: "connection.test" as const,
    data: { message: "Test webhook from YouGrow" },
  };
  const first = await sendConnectionWebhook(conn, event, { db, ...deps });
  if (first.ok || !STARTING_UP.has(first.error)) return ok(first);
  const second = await sendConnectionWebhook(conn, event, { db, ...deps });
  return ok({ ...second, attempts: 2, firstError: first.error });
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
  return ok({ events, rejections: diagnostics?.recentRejections ?? [], unchanged: diagnostics?.unchangedWrites ?? null });
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

/** How many of the most recently seen users the step check reads. */
const PLACEMENT_SAMPLE = 200;

/**
 * Which onboarding steps the product sends somewhere other than where the
 * catalog counts them (per brand vs per person), from its most recently seen
 * users — for the Catalog and Users tabs to flag, with the fix.
 */
export async function getStepPlacement(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ApiResult> {
  const conn = await loadConnection(ctx, id, db);
  if (!conn) return fail(404, "not_found");
  const users = await forTenant(ctx, db).productUsers.find({
    where: [["connectionId", "==", id]],
    orderBy: [["lastSeenAt", "desc"]],
    limit: PLACEMENT_SAMPLE,
  });
  return ok(stepPlacement(users, conn.catalog));
}

/** How many of a user's latest writes the lookup shows. */
const LOOKUP_WRITES = 20;

/**
 * One user, looked up by the product's own user id — what an integrator checks
 * after a test sign-up, without needing the API secret: the state GET
 * /api/v2/users/{id} returns (with the journeys they're in and their opt-outs),
 * the consent YouGrow applies, and their latest writes. Within 30 days of an
 * erasure, the tombstone says when they were erased.
 */
export async function lookupConnectionUser(
  ctx: TenantContext,
  id: string,
  externalUserId: string,
  db?: FirestoreLike,
): Promise<ApiResult> {
  const userId = externalUserId.trim();
  if (!userId || userId.length > 256) return fail(400, "invalid_input", "userId");
  const conn = await loadConnection(ctx, id, db);
  if (!conn) return fail(404, "not_found");
  const repo = forTenant(ctx, db);
  const docId = productUserDocId(conn.id, userId);
  const user = await repo.productUsers.getById(docId);
  if (!user || user.connectionId !== conn.id) return ok({ found: false });
  if (user.status !== "active") return ok({ found: false, erasedAt: user.deletedAt ?? user.updatedAt });
  // Equality only (no composite index): a user's rows are few, so sort them here.
  const [view, rows] = await Promise.all([
    getUserView(ctx, conn, userId, { db }),
    repo.productEvents.find({ where: [["productUserId", "==", docId]], limit: 200 }),
  ]);
  if (!view) return ok({ found: false });
  const journeyIds = [...new Set(view.enrolments.map((e) => e.journeyId))];
  const journeys = await Promise.all(journeyIds.map((j) => repo.lifecycleJourneys.getById(j)));
  const names = new Map(journeys.flatMap((j) => (j ? [[j.id, j.name] as const] : [])));
  return ok({
    found: true,
    user: {
      ...view,
      enrolments: view.enrolments.map((e) => ({ ...e, journeyName: names.get(e.journeyId) ?? null })),
    },
    /** What YouGrow applies: e.g. corporate_subscriber counts as none for a free-mail address. */
    effectiveConsent: user.consent?.basis ?? null,
    firstSeenAt: user.firstSeenAt,
    lastSeenAt: user.lastSeenAt,
    writes: rows
      .sort((x, y) => y.receivedAt.localeCompare(x.receivedAt))
      .slice(0, LOOKUP_WRITES)
      .map((e) => ({
        at: e.receivedAt,
        type: e.type,
        event: e.event,
        applied: e.applied,
        skipped: e.skipped ?? null,
        payload: e.payload,
        ignoredFields: e.ignoredFields ?? [],
      })),
  });
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
  opts: { db?: FirestoreLike } = {},
): Promise<ApiResult> {
  const parsed = FireInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const conn = await loadConnection(ctx, id, opts.db);
  if (!conn) return fail(404, "not_found");
  if (conn.kind !== "sandbox") return fail(400, "not_a_sandbox");
  const r = await fireSandboxEvent(ctx, conn, parsed.data.userId, parsed.data.action, { db: opts.db });
  return { status: r.status, body: r.body };
}
