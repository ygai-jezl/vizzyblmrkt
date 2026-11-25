import {
  changeOrganisationConnection,
  disconnectOrganisationConnectionRecord,
  endPart,
  eraseOrganisationWork,
  forTenant,
  getOrganisationConnection,
  isRateLimited,
  listOrganisationConnections,
  organisationMembership,
  pageRegionOrganisationConnections,
  provisionedRegions,
  removePartEntry,
  repairParts,
  REPAIR_AFTER_MS,
  type BrandRef,
  type SourceRef,
  type TenantContext,
  type WorkStores,
} from "@/lib/tenant";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { OrganisationConnection } from "@/lib/types/organisationConnection";
import { FRESHNESS_CLEAR } from "@/lib/content/blog/freshnessErase";
import { eraseConnectionData, type SearchIndexOf } from "./erase";
import { isGoogleRevokeEnabled } from "./flags";
import { revokeGoogleToken, type GoogleDeps } from "./google";
import type { ConnectorErrorCode } from "./messages";
import type { ConnectorFetchDeps } from "./safeFetch";
import { SHARE_ADDRESS_CAP } from "./service";
import { deleteShareAccount, forgetShareTokens, projectOfShareAccount, type ShareDeps } from "./shareAccess";
import { checkPart, PartCache, storesOf, type SourceDeps } from "./sources";
import { REFRESH_SLOT } from "./tokenKeeper";
import { openConnectorSecret, VaultOpenError } from "./vault";

/**
 * An organisation's own connections (Connectors 3, ADR-0015), at the organisation's level: what the
 * organisation may hold and make, and how its connections end, whatever any switch says.
 *
 * - Google addresses: at most SHARE_ADDRESS_CAP (5) per organisation per connector, counting those
 *   still connected and the disconnected ones whose address a failed delete left at Google, in every
 *   provisioned region. The identities project's service account quota is shared by every brand and
 *   organisation of a copy, and this cap is what stops one organisation filling it.
 * - Making an address and checking a pasted token are rate limited per organisation
 *   (`connector-share-org:` and `connector-check-org:`), whichever brand an owner acts from.
 * - At most ORG_CONNECTIONS_CAP (20) connected connections per organisation per connector, counted
 *   in every provisioned region, so every list of them stays small and is read whole.
 * - Disconnect at the organisation: its record disconnected with its secrets emptied and every part
 *   ending (every brand stops reading at once), then each brand record ended and erased in its own
 *   region and the Google address deleted. A Google sign in is revoked only when an owner pressed
 *   Disconnect (whose confirm warns) or the operator purge runs, and only with
 *   CONNECTOR_GOOGLE_REVOKE_ENABLED: Google's revoke ends every grant that account gave this app,
 *   other organisations' and brands' sign ins included. A disconnect nobody asked for (the lane's
 *   sweep, a move that empties the organisation, an id taken up again) empties the secrets, so
 *   YouGrow keeps no usable token, and never revokes.
 * - Moves never leave a sign in behind (pick 21): a brand that leaves an organisation has its parts
 *   from it ended; an organisation left with no brands has every connection disconnected, in every
 *   region; and an organisation id taken up again carries no connected sign in.
 * - Housekeeping (the lane, whenever CONNECTORS_ENABLED is on, whatever sharing or plans say): a
 *   brand's part ends only on positive evidence (src/lib/connectors/sources.ts checkPart); a
 *   disconnected brand record's entry is dropped from its organisation's record; and each region's
 *   connected organisation connections are swept: those of an organisation gone or with no brands
 *   are disconnected, and half done gives, changes and take backs are repaired.
 */

export interface OrganisationDeps extends SourceDeps, Pick<ConnectorFetchDeps, "limit"> {}

export interface OrganisationActionDeps extends OrganisationDeps, Pick<GoogleDeps, "transport" | "log">, ShareDeps {
  searchIndex?: SearchIndexOf;
  /** When each erase's article step stops (eraseConnectionData): the lane's deadline, or a request's own. */
  deadlineMs?: number;
}

/** New Google addresses one organisation may make for one connector: a few a minute, ten an hour. */
export const ORG_SHARE_CREATE_LIMIT = { burst: 3, hourly: 10 };
/** Token checks one organisation may make for one connector. */
export const ORG_TOKEN_CHECK_LIMIT = { burst: 5, hourly: 30 };
/** Connected connections one organisation may hold for one connector, in every region together. */
export const ORG_CONNECTIONS_CAP = 20;

const atGoogle = (c: OrganisationConnection) => c.method === "share_access" && Boolean(c.serviceAccount && !c.serviceAccount.deletedAt);

/** How many Google addresses the organisation holds for a connector, in every region. */
export async function organisationShareAddresses(organisationId: string, connectorId: string, deps: OrganisationDeps = {}): Promise<number> {
  return (await listOrganisationConnections(organisationId, { connectorId }, storesOf(deps))).filter(atGoogle).length;
}

const limitOf = (deps: OrganisationDeps) => deps.limit ?? ((subject: string, config: Parameters<typeof isRateLimited>[1]) => isRateLimited(subject, config));

/**
 * Whether the organisation may make another Google address for a connector now: under the cap
 * (org_share_limit when not) and under its rate limit (busy when not).
 */
export async function organisationShareRoom(organisationId: string, connectorId: string, deps: OrganisationDeps = {}): Promise<{ ok: true } | { ok: false; code: ConnectorErrorCode }> {
  if ((await organisationShareAddresses(organisationId, connectorId, deps)) >= SHARE_ADDRESS_CAP) return { ok: false, code: "org_share_limit" };
  if (await limitOf(deps)(organisationId, { prefix: `connector-share-org:${connectorId}`, burstLimit: ORG_SHARE_CREATE_LIMIT.burst, hourlyLimit: ORG_SHARE_CREATE_LIMIT.hourly })) return { ok: false, code: "busy" };
  return { ok: true };
}

/** Whether the organisation may connect another connection for a connector (under ORG_CONNECTIONS_CAP, counted in every region). */
export async function organisationConnectionRoom(organisationId: string, connectorId: string, deps: OrganisationDeps = {}): Promise<boolean> {
  const held = (await listOrganisationConnections(organisationId, { connectorId }, storesOf(deps))).filter((c) => c.status === "connected").length;
  return held < ORG_CONNECTIONS_CAP;
}

/** Whether the organisation may check another pasted token for a connector now (busy when not). */
export async function organisationTokenCheckRoom(organisationId: string, connectorId: string, deps: OrganisationDeps = {}): Promise<boolean> {
  return !(await limitOf(deps)(organisationId, { prefix: `connector-check-org:${connectorId}`, burstLimit: ORG_TOKEN_CHECK_LIMIT.burst, hourlyLimit: ORG_TOKEN_CHECK_LIMIT.hourly }));
}

// --- Ending -------------------------------------------------------------------------------------

const brandDb = (region: BrandRef["region"], deps: SourceDeps) => deps.regionDb?.(region) ?? deps.db;
const refOf = (c: Pick<OrganisationConnection, "organisationId" | "id" | "region">): SourceRef => ({ organisationId: c.organisationId, connectionId: c.id, region: c.region });
const warn = (what: string, err: unknown) => console.warn(`[connectors] ${what}:`, err instanceof Error ? err.message.slice(0, 200) : "error");

/** Erase what a brand record collected, in the brand's own region. A failure stays pending for the lane. */
async function eraseBrandRecord(brand: BrandRef, useId: string, by: string, deps: OrganisationActionDeps): Promise<void> {
  const ctx: TenantContext = { tenantId: brand.tenantId, region: brand.region, source: "system" };
  try {
    await eraseConnectionData(ctx, useId, "all", { by, now: deps.now, db: brandDb(brand.region, deps), searchIndex: deps.searchIndex, deadlineMs: deps.deadlineMs });
  } catch (err) {
    warn(`erase after a part ended failed for ${useId}; the lane tries again`, err);
  }
}

/**
 * End one brand's part, in its three steps, then erase what it collected. Never revokes, never
 * deletes an address. True when the brand record went disconnected now.
 */
export async function endOnePart(
  source: SourceRef,
  brand: BrandRef,
  useId: string,
  what: { by: string; code: "part_ended" | "stopped_using" | "left" | "disconnected"; onlyIf?: (current: OrganisationConnection) => boolean },
  deps: OrganisationActionDeps = {},
): Promise<boolean> {
  const at = (deps.now ?? new Date()).toISOString();
  const r = await endPart({ source, brand, useId, by: what.by, at, code: what.code, evenIfSourceFails: true, ...(what.onlyIf ? { onlyIf: what.onlyIf } : {}) }, storesOf(deps));
  if (r.ended) await eraseBrandRecord(brand, useId, what.by, deps);
  return r.ended;
}

/** Delete an organisation connection's Google address at Google; deletedAt is set, or a cleanup_failed row left. */
async function deleteOrganisationAddress(source: SourceRef, sa: NonNullable<OrganisationConnection["serviceAccount"]>, by: string, deps: OrganisationActionDeps): Promise<boolean> {
  forgetShareTokens(sa.email);
  const project = projectOfShareAccount(sa.email);
  const r = project ? await deleteShareAccount(project, sa.uniqueId, deps) : ({ ok: false, code: "share_unconfigured", retryAfterSec: null } as const);
  const at = (deps.now ?? new Date()).toISOString();
  await changeOrganisationConnection(
    source.organisationId,
    source.connectionId,
    source.region,
    (cur) =>
      r.ok
        ? cur.serviceAccount && cur.serviceAccount.uniqueId === sa.uniqueId && !cur.serviceAccount.deletedAt
          ? { patch: { serviceAccount: { ...cur.serviceAccount, deletedAt: at }, updatedAt: at }, activity: [] }
          : null
        : { patch: {}, activity: [{ kind: "cleanup_failed", by, at, code: r.code }] },
    storesOf(deps),
  ).catch((err) => warn(`recording the address delete for ${source.connectionId} failed`, err));
  return r.ok;
}

export interface OrganisationDisconnectOutcome {
  /** The record was found (in the region named). */
  found: boolean;
  /** It went disconnected now. */
  disconnected: boolean;
  /** Brand records ended now. */
  ended: number;
  revoked: boolean;
  /** Its Google address: deleted now, not deleted (a cleanup_failed row; run again), or none to delete. */
  addressDeleted: boolean | null;
}

/**
 * Disconnect an organisation's connection: every brand stops reading at once (step one), each brand
 * record is ended and erased in its own region, and the Google address is deleted. A Google sign in
 * is revoked only with `revoke` (an owner's Disconnect, whose confirm warns, and the operator
 * purge pass it as CONNECTOR_GOOGLE_REVOKE_ENABLED); a disconnect nobody asked for empties the
 * secrets and never revokes, because Google's revoke also ends that account's other sign ins with
 * this app. Safe to run again: a disconnected record has any part still ending finished and an
 * address a failed delete left deleted. Whatever any switch says.
 */
export async function disconnectOrganisationConnection(
  source: SourceRef,
  by: string,
  deps: OrganisationActionDeps = {},
  opts: { revoke?: boolean } = {},
): Promise<OrganisationDisconnectOutcome> {
  const stores = storesOf(deps);
  const at = (deps.now ?? new Date()).toISOString();
  const step = await disconnectOrganisationConnectionRecord(source, { by, at }, stores);
  const current = step?.after ?? (await getOrganisationConnection(source.organisationId, source.connectionId, source.region, stores));
  if (!current) return { found: false, disconnected: false, ended: 0, revoked: false, addressDeleted: null };
  // One deadline for every brand's article step, so an owner's Disconnect of a connection with many
  // brands answers in time: a brand whose step didn't fit stays pending for its lane.
  const each: OrganisationActionDeps = { ...deps, deadlineMs: deps.deadlineMs ?? Date.now() + FRESHNESS_CLEAR.BUDGET_MS };
  let ended = 0;
  for (const p of current.parts) {
    try {
      if (await endOnePart(source, { tenantId: p.tenantId, region: p.region }, p.useId, { by: p.endedBy ?? by, code: "part_ended" }, each)) ended += 1;
    } catch (err) {
      // Left ending on the organisation's record: the brand's own housekeeping ends its record (its
      // source reads disconnected), and the organisation purge's dry run still counts the entry.
      warn(`ending ${p.useId} after Disconnect failed; the brand's housekeeping finishes it`, err);
    }
  }
  let revoked = false;
  const sealed = step?.before.method === "oauth_pkce" ? step.before.secrets[REFRESH_SLOT] : undefined;
  if (sealed && opts.revoke && isGoogleRevokeEnabled()) {
    try {
      revoked = await revokeGoogleToken(openConnectorSecret(source.organisationId, source.connectionId, REFRESH_SLOT, sealed), deps);
    } catch (err) {
      if (!(err instanceof VaultOpenError)) throw err;
    }
  }
  const sa = current.method === "share_access" && current.serviceAccount && !current.serviceAccount.deletedAt ? current.serviceAccount : null;
  const addressDeleted = sa ? await deleteOrganisationAddress(source, sa, by, deps) : null;
  return { found: true, disconnected: Boolean(step), ended, revoked, addressDeleted };
}

/**
 * After a brand left an organisation (move-brand, Bring in, Move out): end its parts from that
 * organisation, wherever each is kept, and erase what they collected. With no organisation named,
 * every part from an organisation the brand is no longer in. Returns how many ended now.
 */
export async function endBrandParts(brand: BrandRef, opts: { fromOrganisationId?: string; by: string }, deps: OrganisationActionDeps = {}): Promise<number> {
  const ctx: TenantContext = { tenantId: brand.tenantId, region: brand.region, source: "system" };
  const conns = await forTenant(ctx, brandDb(brand.region, deps)).dataConnections.find({ where: [["status", "==", "connected"]], limit: 200 });
  let ended = 0;
  for (const c of conns) {
    if (!c.source || (opts.fromOrganisationId && c.source.organisationId !== opts.fromOrganisationId)) continue;
    if (await endOnePart(c.source, brand, c.id, { by: opts.by, code: "left" }, deps)) ended += 1;
  }
  return ended;
}

/**
 * Disconnect, in every region, the connected connections of an organisation that is gone or lists
 * no brands any more: nobody is left for their parts to serve, and a later claimant of the id must
 * never inherit them. An organisation that still lists brands keeps its connections. Returns how
 * many were disconnected. A read error throws, so nothing is decided on it.
 */
export async function disconnectEmptiedOrganisation(organisationId: string, by: string, deps: OrganisationActionDeps = {}): Promise<number> {
  const control = deps.controlDb ?? deps.db;
  const m = control ? await organisationMembership(organisationId, control) : await organisationMembership(organisationId);
  if (m.exists && m.brandIds.length > 0) return 0;
  // Its connections only: the organisation's Work stays (its whole business tasks and their log)
  // until the id is taken up again, so a move that empties it never erases what the team wrote.
  return disconnectEveryConnection(organisationId, by, deps);
}

/** Disconnect every connected connection kept under an organisation id, in any region. Returns how many. */
async function disconnectEveryConnection(organisationId: string, by: string, deps: OrganisationActionDeps): Promise<number> {
  const conns = (await listOrganisationConnections(organisationId, {}, storesOf(deps))).filter((c) => c.status === "connected" || atGoogle(c));
  let n = 0;
  for (const c of conns) {
    const r = await disconnectOrganisationConnection(refOf(c), by, deps);
    if (r.disconnected) n += 1;
  }
  return n;
}

/** Where the organisation's Work is read: each region's database, and the control plane's for its task counter. */
export function workStoresOf(deps: OrganisationActionDeps): WorkStores {
  return { ...storesOf(deps), controlDb: deps.controlDb ?? deps.db };
}

/**
 * Before an empty organisation id is taken up again (move-brand --to new, Move out, the backfill,
 * a new brand), disconnect every connected connection kept under it in any region, so the new
 * owners never inherit a sign in or an address, and erase the Work left under it (its tasks, its
 * log and its task counter, in every region; ADR-0018), so they never inherit a task either.
 * Whatever any switch says. A region that can't be read or erased throws, so the id is not taken
 * up. Returns how many connections were disconnected.
 */
export async function clearOrganisationIdForReuse(organisationId: string, by: string, deps: OrganisationActionDeps = {}): Promise<number> {
  const n = await disconnectEveryConnection(organisationId, by, deps);
  await eraseOrganisationWork(organisationId, by, workStoresOf(deps));
  return n;
}

// --- Housekeeping --------------------------------------------------------------------------------

/**
 * The end evidence, read again inside step one's transaction on the freshest organisation record:
 * true when the record is disconnected or for another connector or method, or the brand's entry is
 * gone, names another brand record, or is `ending`; or is `active` with another part since longer
 * than REPAIR_AFTER_MS. A `pending` entry (a give or change running, which the sweep repairs) and
 * an `active` entry matching the brand record end nothing, and nor does an `active` one changed
 * within REPAIR_AFTER_MS (a change that finished after the brand record was read).
 */
function stillEnded(brand: BrandRef, rec: Pick<DataConnection, "id" | "connectorId" | "method" | "account">, now: Date): (cur: OrganisationConnection) => boolean {
  return (cur) => {
    if (cur.status !== "connected" || cur.connectorId !== rec.connectorId || cur.method !== rec.method) return true;
    const p = cur.parts.find((x) => x.tenantId === brand.tenantId);
    if (!p || p.useId !== rec.id || p.state === "ending") return true;
    if (p.state === "pending") return false;
    if (p.region === brand.region && p.account === rec.account) return false;
    return now.getTime() - Date.parse(p.stateSince) >= REPAIR_AFTER_MS;
  };
}

/**
 * The brand side of housekeeping, for one brand's records, whatever sharing or plans say: a part
 * ends only on positive evidence (the brand points at another organisation or none, its source is
 * missing or disconnected, or its entry is gone, ending, or active with another part or record);
 * and a disconnected part whose entry its organisation's record still lists has the entry dropped.
 * A read error, a switch, a pending give ends nothing; nor does a suspended brand without end
 * evidence.
 *
 * Evidence is never taken from a cache: the lane's run wide PartCache may hold an organisation
 * record read before an owner gave or changed a part. So when the cached check says ended, the
 * brand record is read again and checked with fresh reads, and step one of the end checks the
 * evidence once more inside its transaction (stillEnded), so a part given or changed meanwhile
 * survives.
 */
export async function partHousekeeping(
  ctx: TenantContext,
  connections: readonly DataConnection[],
  deps: OrganisationActionDeps = {},
): Promise<{ ended: number; dropped: number }> {
  const out = { ended: 0, dropped: 0 };
  const parts = connections.filter((c) => c.source);
  if (!parts.length) return out;
  const shared: OrganisationActionDeps = { ...deps, partCache: deps.partCache ?? new PartCache() };
  const brand: BrandRef = { tenantId: ctx.tenantId, region: ctx.region };
  const at = (deps.now ?? new Date()).toISOString();
  for (const c of parts) {
    const source = c.source!;
    try {
      if (c.status === "connected") {
        const check = await checkPart(ctx, c, shared);
        if (check.live || !check.ended) continue;
        // Read again, afresh: the brand record, then the part with no cache.
        const fresh = await forTenant(ctx, brandDb(ctx.region, deps)).dataConnections.getById(c.id);
        if (!fresh || fresh.status !== "connected" || !fresh.source) continue;
        const again = await checkPart(ctx, fresh, { ...deps, partCache: new PartCache() });
        if (again.live || !again.ended) continue;
        // A brand that left is the registry's evidence; any other is the organisation record's, checked once more in step one.
        const left = again.why === "left";
        const what = { by: "system", code: left ? ("left" as const) : ("part_ended" as const), ...(left ? {} : { onlyIf: stillEnded(brand, fresh, deps.now ?? new Date()) }) };
        if (await endOnePart(fresh.source, brand, fresh.id, what, shared)) out.ended += 1;
        continue;
      }
      const src = await getOrganisationConnection(source.organisationId, source.connectionId, source.region, storesOf(shared));
      if (src?.parts.some((p) => p.useId === c.id && p.tenantId === ctx.tenantId) && (await removePartEntry(source, ctx.tenantId, c.id, { by: "system", at, code: "repaired" }, storesOf(shared)))) {
        out.dropped += 1;
      }
    } catch (err) {
      warn(`housekeeping for part ${c.id} failed; tried again next run`, err);
    }
  }
  return out;
}

export interface SweepResult {
  /** Connections disconnected because their organisation is gone or has no brands. */
  disconnected: number;
  /** Parts repaired: made active, put back, removed or finished. */
  repaired: number;
}

/** A page of the sweep, and how often its starting point moves on. */
const SWEEP_PAGE = 100;
const SWEEP_TURN_MS = 30 * 60_000;
/** The characters an organisation connection id is made of after `ocn_`, in sort order. */
const ID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";

/**
 * Where a run's sweep starts in each region: `ocn_` and one id character, moving on one character
 * every SWEEP_TURN_MS. Ids are random, so a sweep cut short by the deadline starts elsewhere next
 * time and every record is reached within a bounded number of runs.
 */
export function sweepStart(nowMs: number): string {
  return `ocn_${ID_CHARS[Math.floor(nowMs / SWEEP_TURN_MS) % ID_CHARS.length]}`;
}

/**
 * The lane's sweep over every region's connected organisation connections (equality on status,
 * ordered by id, a page at a time, from a starting id that moves on each run and wraps round):
 * those whose organisation is gone or lists no brands are disconnected (which also catches moves an
 * older build made), and the parts a give, change or take back left half done are repaired, on
 * positive evidence only. Whatever any switch says; a region or an organisation that can't be read
 * is left for the next run.
 */
export async function sweepOrganisationConnections(opts: { deadlineMs: number; clock?: () => number; minLeftMs?: number }, deps: OrganisationActionDeps = {}): Promise<SweepResult> {
  const clock = opts.clock ?? Date.now;
  const minLeft = opts.minLeftMs ?? 0;
  const result: SweepResult = { disconnected: 0, repaired: 0 };
  const control = deps.controlDb ?? deps.db;
  const memberships = new Map<string, Promise<{ exists: boolean; brandIds: string[] }>>();
  const membership = (id: string) => {
    let hit = memberships.get(id);
    if (!hit) {
      hit = control ? organisationMembership(id, control) : organisationMembership(id);
      memberships.set(id, hit);
    }
    return hit;
  };
  const visit = async (c: OrganisationConnection) => {
    try {
      const m = await membership(c.organisationId);
      if (!m.exists || m.brandIds.length === 0) {
        // Nobody asked for this disconnect, so it never revokes (see disconnectOrganisationConnection).
        if ((await disconnectOrganisationConnection(refOf(c), "system", { ...deps, now: new Date(clock()), deadlineMs: Date.now() + (opts.deadlineMs - clock()) })).disconnected) result.disconnected += 1;
        return;
      }
      if (c.parts.every((p) => p.state === "active")) return;
      const repaired = await repairParts(c, { by: "system", now: new Date(clock()) }, storesOf(deps));
      result.repaired += repaired.filter((r) => r.outcome !== "skipped").length;
    } catch (err) {
      warn(`sweeping ${c.id} failed; tried again next run`, err);
    }
  };
  const start = sweepStart(clock());
  const out = () => opts.deadlineMs - clock() < minLeft;
  for (const region of provisionedRegions()) {
    if (out()) break;
    try {
      // From the starting id to the end, then from the first id up to the start.
      for (const pass of ["from_start", "wrap"] as const) {
        let after: string | null = pass === "from_start" ? start : null;
        let done = false;
        while (!done && !out()) {
          const page = await pageRegionOrganisationConnections(region, { connected: true, after, limit: SWEEP_PAGE }, storesOf(deps));
          for (const c of page.records) {
            if (out()) break;
            if (pass === "wrap" && c.id > start) {
              done = true;
              break;
            }
            await visit(c);
          }
          if (!page.full || !page.last || (pass === "wrap" && page.last > start)) done = true;
          after = page.last;
        }
      }
    } catch (err) {
      warn(`sweeping organisation connections in ${region} failed; tried again next run`, err);
    }
  }
  return result;
}
