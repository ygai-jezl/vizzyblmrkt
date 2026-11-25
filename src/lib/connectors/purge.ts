import { sourceKeyOf } from "@/lib/search/types";
import {
  changeDataConnection,
  countDataConnectionActivity,
  countOrganisationConnectionActivity,
  endPart,
  forTenant,
  listOrganisationConnections,
  scanRegionOrganisationConnections,
  OPERATOR_LABEL,
  provisionedRegions,
  purgeDataConnection,
  purgeOrganisationConnection,
  type OrganisationPurgeCounts,
  type OrganisationStores,
  type PurgeCounts,
  type TenantContext,
} from "@/lib/tenant";
import type { Region } from "@/lib/types/tenant";
import type { OrganisationConnection } from "@/lib/types/organisationConnection";
import { searchStoreFor } from "@/lib/tenant/searchIndex";
import type { FirestoreLike } from "@/lib/tenant/types";
import { freshCollect, type DataConnection } from "@/lib/types/dataConnection";
import { eraseConnectionData, pendingWith, type SearchIndexOf } from "./erase";
import { isGoogleRevokeEnabled } from "./flags";
import { revokeGoogleToken, type GoogleDeps } from "./google";
import { searchTextRef } from "./keys";
import { searchConsoleManifest } from "./manifests/searchConsole";
import { deleteConnectionAddress } from "./service";
import { countSignals } from "./signals/store";
import { countSnapshots } from "./snapshots";
import { brandTag, copyTag, deleteShareAccount, identitiesProject, listShareAccounts, orgTag, type ShareDeps } from "./shareAccess";
import { disconnectOrganisationConnection } from "./organisation";
import { organisationSignInMayShareAccount, storesOf } from "./sources";
import { REFRESH_SLOT } from "./tokenKeeper";
import { openConnectorSecret, VaultOpenError } from "./vault";

/**
 * The operator purge (scripts/connectors-purge.ts, ADR-0011): remove what YouGrow keeps for a
 * brand's connections, whatever any switch says. For one connection, or every connection of one
 * brand, it deletes the sealed secrets, the recent list and the activity rows, and everything it
 * collected (its metric snapshots, ADR-0012, its suggestions from those numbers, their open agent
 * actions declined as stale, and a Search Console connection's searches in brand search, ADR-0013,
 * even with indexing off, through src/lib/connectors/erase.ts), marks the
 * connection disconnected and leaves one "purged" row as the trace. A pasted token can't be
 * cancelled from here. A Google sign in is revoked at Google only with
 * CONNECTOR_GOOGLE_REVOKE_ENABLED on, after its purge, because Google's revoke ends every grant
 * that Google account gave this app, for every brand.
 *
 * Share access (Connectors 1c): each connection's Google address is deleted at Google after its
 * purge, and a failed delete is recorded as cleanup_failed for the next run. With the identities
 * project set it also reconciles: it lists YouGrow's addresses there and deletes this brand's (on
 * this copy, by GOOGLE_CLOUD_PROJECT) that no live connection owns (left by a crash between making
 * an address and saving its connection, or by a delete that failed). `addressesOnly` does only
 * that and the disconnected connections' leftover addresses, leaving every record and its history
 * alone.
 *
 * Turning CONNECTORS_ENABLED off is the rollback; this is how the data goes. The dry run counts
 * and writes nothing.
 *
 * Shared connections (Connectors 3, ADR-0015): a brand's part keeps no secret and no address, so
 * its purge revokes and deletes nothing at Google; it also ends the part on its organisation's
 * record, in whatever region that is kept. An organisation's address is tagged for the
 * organisation, never for a brand, so a brand's leftover search never sees it. The organisation
 * purge (purgeOrganisations, `--organisation <orgId|all>`) covers organisation connections in
 * every provisioned region: each is disconnected (its brands' parts ended and erased in their own
 * regions, its address deleted, a sign in revoked only with the switch), its activity and secrets
 * removed, and the organisation's leftover addresses deleted. It runs whatever any switch says, so
 * a revert or a switch turned off never strands a sign in.
 */

export interface PurgeItem {
  connectionId: string;
  connectorId: string;
  status: string;
  secrets: number;
  recent: number;
  activity: number;
  /** Collected numbers it still has (metric snapshots, every generation). */
  snapshots: number;
  /** Its suggestions from collected numbers (data_signals rows, every generation). */
  signals: number;
  /**
   * Whether its searches are in brand search (Search Console only): null when it puts none there,
   * or the index couldn't be read.
   */
  searchEntry: boolean | null;
  /** A shared connection's Google address: still at Google, deleted already, or none. */
  address: "kept" | "deleted" | "none";
}

export interface PurgeReport {
  tenantId: string;
  apply: boolean;
  /** Only leftover Google addresses were looked at; no record was purged. */
  addressesOnly: boolean;
  /** What each connection held before the purge. */
  items: PurgeItem[];
  /**
   * What was removed, with apply: whether a Google sign in was revoked, and whether a shared
   * connection's Google address was deleted (null when it had none to delete).
   */
  removed: Array<
    {
      connectionId: string;
      revoked: boolean;
      /** Revoke was on but skipped: the brand's organisation has a shared Google sign in made by the same person. */
      revokeSkipped?: true;
      addressDeleted: boolean | null;
      snapshotsDeleted: number;
      /** Its data_signals rows deleted, its open suggestions declined as stale, and undecided questions it proposed withdrawn. */
      signalsDeleted: number;
      suggestionsDeclined: number;
      questionsWithdrawn: number;
      /** Its searches left brand search (or none were there), didn't (run again), or it puts none there (null). */
      searchRemoved: boolean | null;
    } & PurgeCounts
  >;
  /** This brand's Google addresses that no live connection owns; deleted is null in a dry run. */
  orphans: Array<{ email: string; connectionId: string; deleted: boolean | null }>;
  /** Why the identities project wasn't looked at, or null when it was. */
  shareSkipped: string | null;
  /** The connection asked for, when this brand has none by that id. */
  missing: string | null;
}

/** "purge:<label>", for the activity row. The label is short: letters, digits, _ and -. */
export function purgeActor(label: string | undefined): string {
  if (!label || !OPERATOR_LABEL.test(label)) throw new Error("--by takes a short label: lower case letters, digits, _ and -, up to 40 characters, with no @ or dots");
  return `purge:${label}`;
}

/** A Google sign in's refresh token to revoke, when the switch is on and it opens here. */
function toRevoke(ctx: TenantContext, c: DataConnection): string | null {
  const sealed = c.secrets[REFRESH_SLOT];
  if (!isGoogleRevokeEnabled() || c.method !== "oauth_pkce" || !sealed) return null;
  try {
    return openConnectorSecret(ctx.tenantId, c.id, REFRESH_SLOT, sealed);
  } catch (err) {
    if (err instanceof VaultOpenError) return null;
    throw err;
  }
}

/** Whether a Search Console connection's searches are in brand search, read whatever any switch says. */
async function searchEntryOf(ctx: TenantContext, c: DataConnection, searchIndex: SearchIndexOf | undefined): Promise<boolean | null> {
  if (c.connectorId !== searchConsoleManifest.id) return null;
  try {
    return (await (searchIndex ?? searchStoreFor)(ctx).getManifest(sourceKeyOf("research", searchTextRef(c.id)))) !== null;
  } catch (err) {
    // A copy without the search databases has nothing in them.
    if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === 5) return false;
    return null;
  }
}

/** A shared connection's address that is still at Google, or null. */
function keptAddress(c: DataConnection) {
  return c.method === "share_access" && c.serviceAccount && !c.serviceAccount.deletedAt ? c.serviceAccount : null;
}

/**
 * This brand's addresses in the identities project that no live connection owns: tagged for this
 * brand and this copy, and naming a connection the brand doesn't have, or one whose address is
 * another or is marked deleted. With a connection named, only addresses naming it. An address
 * tagged for another copy, or for no copy, is never this copy's to delete: another copy sharing the
 * identities project has records this one can't see.
 */
async function findOrphans(
  ctx: TenantContext,
  conns: readonly DataConnection[],
  connectionId: string | undefined,
  deps: ShareDeps,
): Promise<{ project: string; orphans: Array<{ email: string; uniqueId: string; connectionId: string }> } | { skipped: string }> {
  const project = identitiesProject();
  if (!project) return { skipped: "CONNECTORS_IDENTITIES_PROJECT is not set, so no Google address was looked for" };
  const listed = await listShareAccounts(project, deps);
  if (!listed.ok) return { skipped: `listing the identities project failed (${listed.code})` };
  const tag = brandTag(ctx.tenantId);
  const copy = copyTag();
  const orphans: Array<{ email: string; uniqueId: string; connectionId: string }> = [];
  for (const a of listed.accounts) {
    if (!a.owner || a.owner.brand !== tag || a.owner.copy !== copy) continue;
    if (connectionId && a.owner.connectionId !== connectionId) continue;
    const owner = conns.find((c) => c.id === a.owner!.connectionId);
    const owns = owner?.serviceAccount && owner.serviceAccount.uniqueId === a.uniqueId && !owner.serviceAccount.deletedAt;
    if (!owns) orphans.push({ email: a.email, uniqueId: a.uniqueId, connectionId: a.owner.connectionId });
  }
  return { project, orphans };
}

/** Count, and with apply remove, one brand's connection data and its leftover Google addresses. */
export async function purgeConnections(
  ctx: TenantContext,
  opts: { connectionId?: string; apply: boolean; by?: string; now?: Date; db?: FirestoreLike; regionDb?: (region: Region) => FirestoreLike; addressesOnly?: boolean; searchIndex?: SearchIndexOf } & Pick<
    GoogleDeps,
    "transport" | "log"
  > &
    Pick<ShareDeps, "appToken" | "sleep">,
): Promise<PurgeReport> {
  const by = opts.apply ? purgeActor(opts.by) : "";
  const addressesOnly = opts.addressesOnly === true;
  const share: ShareDeps = { transport: opts.transport, log: opts.log, appToken: opts.appToken, sleep: opts.sleep, now: opts.now };
  const repo = forTenant(ctx, opts.db);
  let conns = opts.connectionId ? [await repo.dataConnections.getById(opts.connectionId)].filter((c): c is NonNullable<typeof c> => c !== null) : await repo.dataConnections.find();
  conns = conns.sort((a, b) => a.id.localeCompare(b.id));
  const report: PurgeReport = {
    tenantId: ctx.tenantId,
    apply: opts.apply,
    addressesOnly,
    items: [],
    removed: [],
    orphans: [],
    shareSkipped: null,
    missing: opts.connectionId && !conns.length ? opts.connectionId : null,
  };
  // Addresses only: the disconnected connections whose address is still at Google.
  const targets = addressesOnly ? conns.filter((c) => c.status === "disconnected" && keptAddress(c)) : conns;
  for (const c of targets) {
    report.items.push({
      connectionId: c.id,
      connectorId: c.connectorId,
      status: c.status,
      secrets: Object.keys(c.secrets).length,
      recent: c.recent.length,
      activity: await countDataConnectionActivity(ctx, c.id, opts.db),
      snapshots: await countSnapshots(ctx, c.id, { db: opts.db }),
      signals: await countSignals(ctx, c.id, { db: opts.db }),
      searchEntry: addressesOnly ? null : await searchEntryOf(ctx, c, opts.searchIndex),
      address: c.serviceAccount ? (c.serviceAccount.deletedAt ? "deleted" : "kept") : "none",
    });
  }
  const found = await findOrphans(ctx, conns, opts.connectionId, share);
  if ("skipped" in found) report.shareSkipped = found.skipped;
  else report.orphans = found.orphans.map((o) => ({ email: o.email, connectionId: o.connectionId, deleted: null }));
  if (!opts.apply) return report;

  const at = (opts.now ?? new Date()).toISOString();
  for (const c of targets) {
    const sa = keptAddress(c);
    if (addressesOnly) {
      const deleted = await deleteConnectionAddress(ctx, c.id, sa!, by, { db: opts.db, ...share });
      report.removed.push({ connectionId: c.id, found: true, activityDeleted: 0, secretsDeleted: 0, recentDeleted: 0, revoked: false, addressDeleted: deleted, snapshotsDeleted: 0, signalsDeleted: 0, suggestionsDeclined: 0, questionsWithdrawn: 0, searchRemoved: null });
      continue;
    }
    let signIn = c.source ? null : toRevoke(ctx, c);
    // Google's revoke ends every grant of that account: not while the organisation's shared sign in may be that account's.
    const revokeSkipped = signIn !== null && (await organisationSignInMayShareAccount(ctx, [c.ownerUid], { db: opts.db, regionDb: opts.regionDb }));
    if (revokeSkipped) signIn = null;
    // A part ends on its organisation's record too, wherever that is kept (never revoking anything).
    if (c.source && c.status === "connected") {
      await endPart({ source: c.source, brand: { tenantId: ctx.tenantId, region: ctx.region }, useId: c.id, by, at, code: "part_ended", evenIfSourceFails: true }, storesOf(opts)).catch(() => null);
    }
    // Stopped first, in one change: marked disconnected with everything it collected pending, so a
    // collect run, a look for suggestions or a search sweep that starts now writes nothing, and one
    // already going marks what it wrote for the lane to erase (Disconnect's order).
    await changeDataConnection(
      ctx,
      c.id,
      (cur) => ({ patch: { status: "disconnected", disconnectedAt: cur.disconnectedAt ?? at, collect: { ...(cur.collect ?? freshCollect()), erasePending: pendingWith(cur.collect?.erasePending ?? null, "all"), nextAt: null } }, activity: [] }),
      opts.db,
    );
    // Everything it collected goes next, with no row of its own: the purged row is the trace.
    const erased = await eraseConnectionData(ctx, c.id, "all", { by, now: opts.now, db: opts.db, record: false, searchIndex: opts.searchIndex });
    const snapshotsDeleted = erased.snapshots;
    const searchRemoved = erased.search === "skipped" ? null : erased.search === "removed";
    const counts = await purgeDataConnection(ctx, c.id, by, at, opts.db);
    const revoked = signIn ? await revokeGoogleToken(signIn, { transport: opts.transport, log: opts.log }) : false;
    const addressDeleted = sa ? await deleteConnectionAddress(ctx, c.id, sa, by, { db: opts.db, ...share }) : null;
    report.removed.push({ connectionId: c.id, ...counts, revoked, ...(revokeSkipped ? { revokeSkipped: true as const } : {}), addressDeleted, snapshotsDeleted, signalsDeleted: erased.signals, suggestionsDeclined: erased.declined, questionsWithdrawn: erased.withdrawn, searchRemoved });
  }
  if (!("skipped" in found)) {
    report.orphans = [];
    for (const o of found.orphans) {
      const r = await deleteShareAccount(found.project, o.uniqueId, share);
      report.orphans.push({ email: o.email, connectionId: o.connectionId, deleted: r.ok });
    }
  }
  return report;
}

const ADDRESS_WORDS = { kept: ", a Google address at Google", deleted: ", its Google address deleted", none: "" } as const;

/** The lines the script prints: ids, counts and YouGrow's own Google addresses, never a secret. */
export function purgeLines(r: PurgeReport): string[] {
  const lines: string[] = [];
  if (r.missing) lines.push(`${r.tenantId}: no connection ${r.missing}`);
  for (const i of r.items) {
    lines.push(`${r.tenantId}: ${i.connectionId} (${i.connectorId}, ${i.status}): ${i.secrets} secrets, ${i.recent} recent, ${i.activity} activity rows, ${i.snapshots} collected snapshots, ${i.signals} suggestions${i.searchEntry ? ", its Google searches in brand search" : ""}${ADDRESS_WORDS[i.address]}`);
  }
  for (const x of r.removed) {
    const address = x.addressDeleted === null ? "" : x.addressDeleted ? ", Google address deleted" : ", Google address NOT deleted (recorded as cleanup_failed; run again)";
    const hadSearches = r.items.find((i) => i.connectionId === x.connectionId)?.searchEntry;
    const searches = x.searchRemoved === false ? ", Google searches NOT removed from brand search (run again)" : x.searchRemoved && hadSearches !== false ? ", Google searches removed from brand search" : "";
    if (r.addressesOnly) lines.push(`${r.tenantId}: ${x.connectionId}${address}`);
    else lines.push(`${r.tenantId}: ${x.connectionId} purged: ${x.secretsDeleted} secrets, ${x.recentDeleted} recent, ${x.activityDeleted} activity rows, ${x.snapshotsDeleted} collected snapshots and ${x.signalsDeleted} suggestions removed${x.suggestionsDeclined ? ` (${x.suggestionsDeclined} open, declined)` : ""}${x.questionsWithdrawn ? `, ${x.questionsWithdrawn} proposed brand map questions withdrawn` : ""}${searches}${x.revoked ? ", sign in revoked at Google" : x.revokeSkipped ? ", sign in NOT revoked at Google (its organisation's shared sign in may use the same Google account)" : ""}${address}`);
  }
  for (const o of r.orphans) {
    const what = o.deleted === null ? "no live connection owns it" : o.deleted ? "deleted" : "NOT deleted; run again";
    lines.push(`${r.tenantId}: leftover Google address ${o.email} (for ${o.connectionId}): ${what}`);
  }
  if (r.shareSkipped) lines.push(`${r.tenantId}: ${r.shareSkipped}`);
  return lines;
}


// --- Organisations (Connectors 3) -----------------------------------------------------------------

export interface OrganisationPurgeItem {
  organisationId: string;
  connectionId: string;
  region: Region;
  connectorId: string;
  status: string;
  secrets: number;
  recent: number;
  activity: number;
  /** Parts given out, and how many still to end. */
  parts: number;
  address: "kept" | "deleted" | "none";
}

export interface OrganisationPurgeReport {
  /** An organisation id, or "all". */
  target: string;
  apply: boolean;
  items: OrganisationPurgeItem[];
  removed: Array<{ connectionId: string; ended: number; revoked: boolean; addressDeleted: boolean | null } & OrganisationPurgeCounts>;
  /** Organisation addresses in the identities project that no organisation connection owns; deleted is null in a dry run. */
  orphans: Array<{ email: string; connectionId: string; deleted: boolean | null }>;
  /** Stored organisation connections that don't parse ("all" only): never purged here and never called gone, so they count as left. */
  unreadable: Array<{ region: Region; connectionId: string }>;
  shareSkipped: string | null;
}

export interface OrganisationPurgeOptions extends Pick<GoogleDeps, "transport" | "log">, Pick<ShareDeps, "appToken" | "sleep"> {
  apply: boolean;
  by?: string;
  now?: Date;
  /** Each region's database (tests); unset, the region's own. */
  regionDb?: (region: Region) => FirestoreLike;
  /** The control database (tests). */
  controlDb?: FirestoreLike;
  searchIndex?: SearchIndexOf;
}

const orgKept = (c: OrganisationConnection) => (c.serviceAccount ? (c.serviceAccount.deletedAt ? "deleted" : "kept") : "none");

/**
 * The organisation purge: every connection of one organisation (or of every organisation, "all"),
 * in every provisioned region, whatever any switch says. The dry run counts and writes nothing.
 * With apply, each is disconnected (its brands' parts ended and erased in their own regions, its
 * address deleted, a Google sign in revoked only with CONNECTOR_GOOGLE_REVOKE_ENABLED), then its
 * activity, secrets and parts removed, with one "purged" row left. Then the organisation's
 * addresses in the identities project that no organisation connection owns, on this copy, are
 * deleted. A region that can't be read throws: "nothing left" is never said on a region's silence.
 */
export async function purgeOrganisations(target: string, opts: OrganisationPurgeOptions): Promise<OrganisationPurgeReport> {
  const by = opts.apply ? purgeActor(opts.by) : "";
  const stores: OrganisationStores = opts.regionDb ? { regionDb: opts.regionDb } : {};
  const share: ShareDeps = { transport: opts.transport, log: opts.log, appToken: opts.appToken, sleep: opts.sleep, now: opts.now };
  const conns: OrganisationConnection[] = [];
  const unreadable: Array<{ region: Region; connectionId: string }> = [];
  if (target === "all") {
    for (const region of provisionedRegions()) {
      const scanned = await scanRegionOrganisationConnections(region, {}, stores);
      conns.push(...scanned.records);
      unreadable.push(...scanned.unreadable.map((connectionId) => ({ region, connectionId })));
    }
  } else {
    if (!target.startsWith("org_")) throw new Error("--organisation takes an organisation id (org_...) or all");
    conns.push(...(await listOrganisationConnections(target, {}, stores)));
  }
  conns.sort((a, b) => a.id.localeCompare(b.id));
  const report: OrganisationPurgeReport = { target, apply: opts.apply, items: [], removed: [], orphans: [], unreadable, shareSkipped: null };
  for (const c of conns) {
    report.items.push({
      organisationId: c.organisationId,
      connectionId: c.id,
      region: c.region,
      connectorId: c.connectorId,
      status: c.status,
      secrets: Object.keys(c.secrets).length,
      recent: c.recent.length,
      activity: await countOrganisationConnectionActivity(c.organisationId, c.id, c.region, stores),
      parts: c.parts.length,
      address: orgKept(c),
    });
  }

  // Leftover organisation addresses: tagged for this copy (and this organisation), owned by no record.
  const project = identitiesProject();
  let orphans: Array<{ email: string; uniqueId: string; connectionId: string }> = [];
  if (!project) report.shareSkipped = "CONNECTORS_IDENTITIES_PROJECT is not set, so no Google address was looked for";
  else {
    const listed = await listShareAccounts(project, share);
    if (!listed.ok) report.shareSkipped = `listing the identities project failed (${listed.code})`;
    else {
      const copy = copyTag();
      const tag = target === "all" ? null : orgTag(target);
      // Every organisation's connections in every region, so one region's records never see another's live addresses as orphans.
      const every = target === "all" ? { records: conns, unreadable: unreadable.map((u) => u.connectionId) } : await allOrganisationConnections(stores);
      const owners = every.records;
      for (const a of listed.accounts) {
        const o = a.orgOwner;
        if (!o || o.copy !== copy || (tag && o.org !== tag)) continue;
        // A record that doesn't parse may be live: its address is never called a leftover.
        if (every.unreadable.includes(o.connectionId)) continue;
        const owner = owners.find((c) => c.id === o.connectionId);
        const owns = owner?.serviceAccount && owner.serviceAccount.uniqueId === a.uniqueId && !owner.serviceAccount.deletedAt && owner.status === "connected";
        if (!owns) orphans.push({ email: a.email, uniqueId: a.uniqueId, connectionId: o.connectionId });
      }
      // With apply, the connections purged below delete their own addresses; the rest are leftovers.
      if (opts.apply) orphans = orphans.filter((x) => !conns.some((c) => c.id === x.connectionId && c.serviceAccount?.uniqueId === x.uniqueId && !c.serviceAccount.deletedAt));
      report.orphans = orphans.map((x) => ({ email: x.email, connectionId: x.connectionId, deleted: null }));
    }
  }
  if (!opts.apply) return report;

  const at = (opts.now ?? new Date()).toISOString();
  for (const c of conns) {
    const ref = { organisationId: c.organisationId, connectionId: c.id, region: c.region };
    const off = await disconnectOrganisationConnection(ref, by, { regionDb: opts.regionDb, controlDb: opts.controlDb, now: opts.now, searchIndex: opts.searchIndex, ...share }, { revoke: isGoogleRevokeEnabled() });
    const counts = await purgeOrganisationConnection(c.organisationId, c.id, c.region, by, at, stores);
    report.removed.push({ connectionId: c.id, ended: off.ended, revoked: off.revoked, addressDeleted: off.addressDeleted, ...counts });
  }
  if (project && orphans.length) {
    report.orphans = [];
    for (const o of orphans) {
      const r = await deleteShareAccount(project, o.uniqueId, share);
      report.orphans.push({ email: o.email, connectionId: o.connectionId, deleted: r.ok });
    }
  }
  return report;
}

async function allOrganisationConnections(stores: OrganisationStores): Promise<{ records: OrganisationConnection[]; unreadable: string[] }> {
  const out = { records: [] as OrganisationConnection[], unreadable: [] as string[] };
  for (const region of provisionedRegions()) {
    const scanned = await scanRegionOrganisationConnections(region, {}, stores);
    out.records.push(...scanned.records);
    out.unreadable.push(...scanned.unreadable);
  }
  return out;
}

/** The lines the script prints for the organisation purge: ids, regions and counts, never a secret. */
export function organisationPurgeLines(r: OrganisationPurgeReport): string[] {
  const lines: string[] = [];
  for (const i of r.items) {
    lines.push(`${i.organisationId}: ${i.connectionId} (${i.connectorId}, kept in ${i.region}, ${i.status}): ${i.secrets} secrets, ${i.recent} recent, ${i.activity} activity rows, ${i.parts} parts given${ADDRESS_WORDS[i.address]}`);
  }
  for (const x of r.removed) {
    const address = x.addressDeleted === null ? "" : x.addressDeleted ? ", Google address deleted" : ", Google address NOT deleted (recorded as cleanup_failed; run again)";
    const left = x.partsLeft ? `, ${x.partsLeft} brands' parts NOT ended (their brand database couldn't be written; kept as ending, run again)` : "";
    lines.push(`${x.connectionId} purged: ${x.ended} brands' parts ended and erased, ${x.secretsDeleted} secrets, ${x.recentDeleted} recent, ${x.activityDeleted} activity rows removed${x.revoked ? ", sign in revoked at Google" : ""}${address}${left}`);
  }
  for (const u of r.unreadable) lines.push(`${u.connectionId} (kept in ${u.region}) does not parse, so it was not purged and may still hold a sign in: look at it before reverting`);
  for (const o of r.orphans) {
    const what = o.deleted === null ? "no organisation connection owns it" : o.deleted ? "deleted" : "NOT deleted; run again";
    lines.push(`leftover organisation Google address ${o.email} (for ${o.connectionId}): ${what}`);
  }
  if (r.shareSkipped) lines.push(r.shareSkipped);
  return lines;
}
