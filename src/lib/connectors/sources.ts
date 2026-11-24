import { changeOrganisationConnection, getOrganisation, getOrganisationConnection, getTenantById, type OrganisationStores, type SourceRef, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { Organisation } from "@/lib/types/organisation";
import type { OrganisationConnection } from "@/lib/types/organisationConnection";
import type { Region, Tenant } from "@/lib/types/tenant";
import { isConnectorsSharingEnabled } from "./flags";
import { healthAfterFailure, isCallPaused } from "./health";
import { shareMethod, tokenMethod, type ConnectorManifest } from "./manifest";
import type { ConnectorErrorCode } from "./messages";
import { identitiesProject, shareAccessToken, type ShareDeps } from "./shareAccess";
import { keepFresh, organisationKeeperPort, type KeeperDeps } from "./tokenKeeper";
import { openConnectorSecret, VaultOpenError } from "./vault";

/**
 * A brand's part of its organisation's connection (Connectors 3, ADR-0014): the one check every
 * way out runs, and the token mint for brand records with a `source`.
 *
 * partLive checks, for a brand record with a source:
 * 1. CONNECTORS_SHARING_ENABLED, CONNECTORS_ENABLED and PLANS_ENABLED are on;
 * 2. the brand's registry record, read live (getTenantById, no cache across requests), names the
 *    source's organisation and isn't suspended, and the organisation lists the brand;
 * 3. the source record, read by id in the region its `source` names (which may not be the brand's),
 *    exists, belongs to that organisation, is connected, and has the brand record's connector and
 *    method;
 * 4. its parts hold an `active` entry for exactly this brand, its region, this part and this brand
 *    record. A `pending` or `ending` entry reads nothing.
 * A token also needs the source not paused and its sign in working. A read error refuses this time
 * and ends nothing. Brand records with no source skip it at no cost. Reads are cached per request
 * or lane run through a PartCache.
 *
 * It runs on every token mint, and beside every grants check on a way out: the numbers route, the
 * suggestions route, brand search, signals and planning (Next up, the pack), Review's suggestions
 * and the Connected view's collected line. A refusal touches no other brand.
 *
 * Failures: those of the sign in itself (Google ending it, a token turned down outright, a secret
 * that won't open, an address deleted at Google) go on the organisation's record, in its region,
 * and each part that then tries a call records `source_broken` on its own health. A part's own
 * failures (account_refused, share_not_visible, share_access_lost, a 403 on one site, property or
 * zone) stay on that brand's record.
 */

export interface SourceDeps extends KeeperDeps, ShareDeps {
  /** One fake database for everything (tests). */
  db?: FirestoreLike;
  /** The control database ((default)); tests pass a fake. */
  controlDb?: FirestoreLike;
  /** Each region's database; tests pass a fake per region. */
  regionDb?: (region: Region) => FirestoreLike;
  /** The reads behind partLive, shared by one request or lane run. */
  partCache?: PartCache;
}

/** Where the organisation's connections are read: each region's database. */
export function storesOf(deps: Pick<SourceDeps, "db" | "regionDb">): OrganisationStores {
  if (deps.regionDb) return { regionDb: deps.regionDb };
  const db = deps.db;
  return db ? { regionDb: () => db } : {};
}

const controlOf = (deps: Pick<SourceDeps, "db" | "controlDb">): FirestoreLike | undefined => deps.controlDb ?? deps.db;

/** The three reads partLive makes, kept for one request or one lane run. */
export class PartCache {
  readonly tenants = new Map<string, Promise<Tenant | null>>();
  readonly organisations = new Map<string, Promise<Organisation | null>>();
  readonly sources = new Map<string, Promise<OrganisationConnection | null>>();
}

function cached<T>(map: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let hit = map.get(key);
  if (!hit) {
    hit = read();
    // A failed read is not kept: the next call reads again.
    hit.catch(() => map.delete(key));
    map.set(key, hit);
  }
  return hit;
}

export type PartWhy =
  | "sharing_off"
  | "suspended"
  | "left"
  | "not_listed"
  | "source_missing"
  | "source_disconnected"
  | "mismatch"
  | "no_part"
  | "pending"
  | "ending"
  | "differs"
  | "paused"
  | "broken"
  | "read_failed";

/**
 * Why a part reads nothing, as positive evidence that it has ended (pick 10): the brand points at
 * another organisation or none, the source is missing or disconnected, or the entry is gone,
 * `ending`, or `active` with another part or brand record. Never a switch, never a read error, a
 * suspended brand, an organisation that no longer lists the brand (drift), a pending give or a
 * paused or broken source.
 */
const ENDED: ReadonlySet<PartWhy> = new Set(["left", "source_missing", "source_disconnected", "mismatch", "no_part", "ending", "differs"]);

export type PartCheck =
  | { live: true; source: OrganisationConnection; organisation: Organisation; brand: Tenant }
  | { live: false; code: ConnectorErrorCode; why: PartWhy; ended: boolean; organisation: Organisation | null; brand: Tenant | null };

const refused = (why: PartWhy, organisation: Organisation | null = null, brand: Tenant | null = null): PartCheck => ({
  live: false,
  code: why === "sharing_off" ? "sharing_off" : why === "read_failed" ? "busy" : why === "paused" ? "source_paused" : why === "broken" ? "source_broken" : "part_ended",
  why,
  ended: ENDED.has(why),
  organisation,
  brand,
});

/**
 * The part's state, whatever any switch says: for housekeeping, which ends a part only on positive
 * evidence. `token` also checks the source isn't paused and its sign in works.
 */
export async function checkPart(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  conn: Pick<DataConnection, "id" | "connectorId" | "method" | "account" | "source">,
  deps: SourceDeps,
  opts: { token?: boolean; now?: Date } = {},
): Promise<PartCheck> {
  const src = conn.source;
  if (!src) return refused("no_part");
  const cache = deps.partCache ?? new PartCache();
  const control = controlOf(deps);
  let tenant: Tenant | null;
  let organisation: Organisation | null;
  let source: OrganisationConnection | null;
  try {
    tenant = await cached(cache.tenants, ctx.tenantId, () => (control ? getTenantById(ctx.tenantId, control) : getTenantById(ctx.tenantId)));
    if (!tenant) return refused("left");
    if (tenant.status === "suspended") return refused("suspended", null, tenant);
    if (tenant.organisationId !== src.organisationId) return refused("left", null, tenant);
    organisation = await cached(cache.organisations, src.organisationId, () => (control ? getOrganisation(src.organisationId, control) : getOrganisation(src.organisationId)));
    if (!organisation || !organisation.brandIds.includes(ctx.tenantId)) return refused("not_listed", organisation, tenant);
    source = await cached(cache.sources, `${src.region}:${src.connectionId}`, () => getOrganisationConnection(src.organisationId, src.connectionId, src.region, storesOf(deps)));
  } catch {
    return refused("read_failed");
  }
  const no = (why: PartWhy) => refused(why, organisation, tenant);
  if (!source) return no("source_missing");
  if (source.status !== "connected") return no("source_disconnected");
  if (source.connectorId !== conn.connectorId || source.method !== conn.method) return no("mismatch");
  const part = source.parts.find((p) => p.tenantId === ctx.tenantId);
  if (!part) return no("no_part");
  if (part.useId !== conn.id) return no("differs");
  if (part.state === "ending") return no("ending");
  if (part.state === "pending") return no("pending");
  if (part.region !== ctx.region || part.account !== conn.account) return no("differs");
  if (opts.token) {
    if (isCallPaused(source, opts.now ?? new Date())) return no("paused");
    if (source.health.state === "broken") return no("broken");
  }
  return { live: true, source, organisation, brand: tenant };
}

/** partLive for reading what a part collected, or for a token: the switches, then the part. */
export async function partLive(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  conn: Pick<DataConnection, "id" | "connectorId" | "method" | "account" | "source">,
  deps: SourceDeps = {},
  opts: { token?: boolean; now?: Date } = {},
): Promise<PartCheck> {
  if (!isConnectorsSharingEnabled()) return refused("sharing_off");
  return checkPart(ctx, conn, deps, opts);
}

/** True for a brand's own connection, or a part partLive honours: the filter every way out uses. */
export async function readable(ctx: Pick<TenantContext, "tenantId" | "region">, conn: DataConnection, deps: SourceDeps = {}): Promise<boolean> {
  if (!conn.source) return true;
  return (await partLive(ctx, conn, deps)).live;
}

/** Of these connections, those every way out may read: a brand's own, or a live part. */
export async function readableOnly<C extends DataConnection>(ctx: Pick<TenantContext, "tenantId" | "region">, conns: readonly C[], deps: SourceDeps = {}): Promise<C[]> {
  if (!conns.some((c) => c.source)) return [...conns];
  const shared = { ...deps, partCache: deps.partCache ?? new PartCache() };
  const out: C[] = [];
  for (const c of conns) if (await readable(ctx, c, shared)) out.push(c);
  return out;
}

/**
 * What a brand's own screens say about one of its parts (the Connected view, Review): `live`, it
 * reads; `off`, sharing is off in this copy; `source`, its organisation's sign in needs attention;
 * `paused`, its organisation's owners paused it; `pending`, a give not finished yet; `ended`, its
 * organisation no longer gives it (housekeeping ends it at the next run) or it was ended already;
 * `unknown`, it couldn't be checked just now (a read failed, or the brand and its organisation
 * disagree), so it reads nothing this time.
 */
export type PartReads = "live" | "off" | "source" | "paused" | "pending" | "ended" | "unknown";

export interface PartFacts {
  reads: PartReads;
  /** partLive's answer: every way out reads it. */
  live: boolean;
  /** When its organisation's sign in stopped working (`source`). */
  since: string | null;
  /** The organisation that gives it, and this brand, by name: null when they can't be read. */
  organisation: string | null;
  brand: string | null;
}

/**
 * A part as its brand's screens show it: partLive's answer, then whether its organisation's sign in
 * works and whether its owners paused it. The names are read whatever any switch says (the
 * organisation the brand record names, which the server wrote at the give), so a part from an
 * organisation the brand has left still says which one. A read error names nobody and reads nothing.
 * Reads go through the PartCache, so one request reads each record once.
 */
export async function partFactsOf(ctx: Pick<TenantContext, "tenantId" | "region">, conn: DataConnection, deps: SourceDeps = {}): Promise<PartFacts | null> {
  const src = conn.source;
  if (!src) return null;
  const cache = deps.partCache ?? new PartCache();
  const shared = { ...deps, partCache: cache };
  const control = controlOf(deps);
  const names = async () => {
    const [organisation, brand] = await Promise.all([
      cached(cache.organisations, src.organisationId, () => (control ? getOrganisation(src.organisationId, control) : getOrganisation(src.organisationId))).catch(() => null),
      cached(cache.tenants, ctx.tenantId, () => (control ? getTenantById(ctx.tenantId, control) : getTenantById(ctx.tenantId))).catch(() => null),
    ]);
    return { organisation: organisation?.name ?? null, brand: brand?.tenantName ?? null };
  };
  const facts = async (reads: PartReads, live = false, since: string | null = null): Promise<PartFacts> => ({ reads, live, since, ...(await names()) });
  if (conn.status !== "connected") return facts("ended");
  if (!isConnectorsSharingEnabled()) return facts("off");
  const check = await checkPart(ctx, conn, shared);
  if (!check.live) return facts(check.why === "pending" ? "pending" : check.ended ? "ended" : "unknown");
  const s = check.source;
  if (s.health.state === "broken") return facts("source", true, s.health.since ?? s.health.lastCheckedAt);
  if (s.pausedAt) return facts("paused", true);
  return facts("live", true);
}

const refOf = (s: OrganisationConnection): SourceRef => ({ organisationId: s.organisationId, connectionId: s.id, region: s.region });

/**
 * Mark the organisation's connection broken for a failure of its sign in, in its own region, with
 * a "failed" row. Best effort: a part's call answers source_broken whether or not this lands.
 */
export async function markSourceBroken(source: SourceRef, code: ConnectorErrorCode, by: string, deps: SourceDeps = {}): Promise<void> {
  const now = deps.now ?? new Date();
  const at = now.toISOString();
  await changeOrganisationConnection(
    source.organisationId,
    source.connectionId,
    source.region,
    (cur) => {
      if (cur.status !== "connected") return null;
      const next = healthAfterFailure(cur.health, code, now);
      return next ? { patch: { health: next.health }, activity: [{ kind: "failed", by: by || "system", at, code }] } : null;
    },
    storesOf(deps),
  ).catch(() => null);
}

/** The codes that are the sign in's own, not one part's: the organisation's record carries them. */
const SIGN_IN_FAILURES: ReadonlySet<ConnectorErrorCode> = new Set(["token_refused", "signin_refused", "secret_unopenable"]);

/**
 * After a part's call failed: a failure of the sign in itself (a token turned down outright, Google
 * ending the sign in) marks the organisation's record and reads as source_broken on the part; any
 * other failure is the part's own and is returned as it is. A brand's own connection is untouched.
 */
export async function partFailure(conn: Pick<DataConnection, "source" | "method">, code: ConnectorErrorCode, by: string, deps: SourceDeps = {}): Promise<ConnectorErrorCode> {
  if (!conn.source || conn.method === "share_access" || !SIGN_IN_FAILURES.has(code)) return code;
  await markSourceBroken(conn.source, code, by, deps);
  return "source_broken";
}

/**
 * A part's token, or why not; never `recorded`, so the caller records the code on the brand's
 * record. `about` names the organisation and the brand, for the words of a source that needs its owners.
 */
export type SourceTokenResult =
  | { ok: true; token: string }
  | { ok: false; code: ConnectorErrorCode; retryAfterSec: number | null; recorded: false; about: { organisation: string; brand: string } | null };

/**
 * The token for a call on a brand's part, minted through its organisation's connection: a share
 * access address's short lived token, a Google sign in kept fresh by the token keeper on the
 * organisation's record (its lease and health written there, in its region), or a pasted token
 * opened with the organisation bound in. The brand record's own secrets are never read. Checks the
 * part live first, with the source not paused and its sign in working.
 */
export async function sourceToken(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  conn: DataConnection,
  manifest: ConnectorManifest,
  by: string,
  deps: SourceDeps = {},
): Promise<SourceTokenResult> {
  const check = await partLive(ctx, conn, deps, { token: true, now: deps.now });
  const about = check.organisation && check.brand ? { organisation: check.organisation.name, brand: check.brand.tenantName } : null;
  if (!check.live) return { ok: false, code: check.code, retryAfterSec: null, recorded: false, about };
  const src = check.source;
  const ref = refOf(src);
  const fail = (code: ConnectorErrorCode, retryAfterSec: number | null = null): SourceTokenResult => ({ ok: false, code, retryAfterSec, recorded: false, about });

  if (src.method === "share_access") {
    const share = shareMethod(manifest);
    const sa = src.serviceAccount;
    if (!share || !identitiesProject()) return fail("share_unconfigured");
    if (!sa || sa.deletedAt) return fail("part_ended");
    const r = await shareAccessToken(sa, share.scopes[0]!, deps);
    if (r.ok) return { ok: true, token: r.token };
    if ("gone" in r && r.gone) {
      await markSourceBroken(ref, "share_access_lost", by, deps);
      return fail("source_broken");
    }
    return fail(r.code, r.retryAfterSec);
  }

  if (src.method === "oauth_pkce") {
    const kept = await keepFresh(organisationKeeperPort(ref, storesOf(deps)), src, by, deps);
    if (kept.ok) return { ok: true, token: kept.token };
    if (kept.code === "signin_refused") return fail("source_broken");
    if (kept.code === "secret_unopenable") {
      await markSourceBroken(ref, "secret_unopenable", by, deps);
      return fail("source_broken");
    }
    if (kept.code === "disconnected") return fail("part_ended");
    return fail(kept.code, kept.retryAfterSec);
  }

  const method = tokenMethod(manifest);
  const sealed = method ? src.secrets[method.auth.field] : undefined;
  try {
    if (!sealed) throw new VaultOpenError("unopenable");
    return { ok: true, token: openConnectorSecret(src.organisationId, src.id, method!.auth.field, sealed) };
  } catch (err) {
    if (!(err instanceof VaultOpenError)) throw err;
    await markSourceBroken(ref, "secret_unopenable", by, deps);
    return fail("source_broken");
  }
}

/**
 * When the organisation's connection holds collecting for every part (a Search Console or
 * Cloudflare quota answer), or null. Read through partLive, so a part that reads nothing returns
 * null and its token is refused next. Live reads never look at it.
 */
export async function sourceHeldUntil(ctx: Pick<TenantContext, "tenantId" | "region">, conn: DataConnection, deps: SourceDeps = {}): Promise<string | null> {
  if (!conn.source) return null;
  const check = await partLive(ctx, conn, deps);
  if (!check.live) return null;
  const hold = check.source.collectHold;
  const now = (deps.now ?? new Date()).getTime();
  return hold && Date.parse(hold.until) > now ? hold.until : null;
}

/**
 * Hold collecting for every part of an organisation's connection until then (a quota answer the
 * provider counts per user or per token), with a "held" row. A later hold already set stays.
 * Best effort: the brand's own record carries its own hold either way.
 */
export async function holdSource(source: SourceRef, until: Date, reason: string, deps: SourceDeps = {}): Promise<void> {
  const at = (deps.now ?? new Date()).toISOString();
  await changeOrganisationConnection(
    source.organisationId,
    source.connectionId,
    source.region,
    (cur) => {
      if (cur.status !== "connected") return null;
      if (cur.collectHold && Date.parse(cur.collectHold.until) >= until.getTime()) return null;
      return { patch: { collectHold: { until: until.toISOString(), reason } }, activity: [{ kind: "held", by: "system", at, code: reason }] };
    },
    storesOf(deps),
  ).catch(() => null);
}
