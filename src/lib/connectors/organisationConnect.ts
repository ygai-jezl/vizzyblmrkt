import { z } from "zod";
import {
  changeOrganisationConnection,
  createOrganisationConnection,
  forTenant,
  getTenantById,
  isBrandAdminLive,
  listOrganisationConnections,
  newOrganisationConnectionId,
  recordOrganisationConnectionChange,
  type OrganisationConnectionChangeKind,
} from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { REGION_CONFIGS } from "@/lib/tenant/region";
import type { ConnectionGrant, ConnectionServiceAccount, DataConnection } from "@/lib/types/dataConnection";
import type { OrganisationConnection, PartState } from "@/lib/types/organisationConnection";
import type { Region } from "@/lib/types/tenant";
import { ACCOUNT_HOOKS } from "./handlers";
import { isConnectorsChatEnabled, isConnectorsCollectEnabled, isGoogleRevokeEnabled } from "./flags";
import { healthyAt } from "./health";
import { shareMethod, tokenMethod, type ConnectorIcon, type ConnectMethodName, type ConnectorManifest } from "./manifest";
import { connectorMessage, type ConnectorErrorCode } from "./messages";
import { disconnectOrganisationConnection, organisationShareRoom, organisationTokenCheckRoom, type OrganisationActionDeps } from "./organisation";
import { organisationHookConnection, organisationOutcome, organisationToken, ownedConnection, sourceRefOf, type OrganisationOwner } from "./organisationOwner";
import { getConnector, knownConnector, readyMethods } from "./registry";
import { checkFields, cleanLabel, collectViewOf, providerRefusal, type CollectView, type ServiceResult } from "./service";
import { createOrganisationShareAccount, deleteShareAccount, identitiesProject } from "./shareAccess";
import { storesOf } from "./sources";
import { isVaultConfigured, sealConnectorSecret, type SealedSecret } from "./vault";

/**
 * Connecting for an organisation, and what its owners see of its connections (Connectors 3,
 * ADR-0014). Every function takes an owner the route checked live (src/lib/connectors/
 * organisationOwner.ts) and a connection id it finds on the server, in any provisioned region,
 * and refuses unless it is the owner's organisation's.
 *
 * - Connect: a pasted Cloudflare token is checked by listing the zones it reaches (the accounts
 *   hook; listAccounts refuses token connections) and saved sealed with the organisation bound in;
 *   a Google address is made for the organisation (createOrganisationShareAccount, tagged for it);
 *   Sign in with Google starts in src/lib/connectors/signIn.ts. Each is kept in the region of the
 *   brand it is connected from. Nothing is collected until an owner gives a brand a part.
 * - Pause, resume and Disconnect are any owner's. Disconnect ends every brand's part and erases
 *   what each collected in its own region, deletes the Google address, and revokes a Google sign in
 *   only with CONNECTOR_GOOGLE_REVOKE_ENABLED (src/lib/connectors/organisation.ts).
 * - Each change is recorded on the organisation's own change log after it is saved, best effort.
 * - The view lists the organisation's connections from every region, and for each part its brand,
 *   the brand's region, and its collected days, readers and health from the brand's own record, read
 *   in that brand's region. A Google sign in's signer shows as "you" or "another owner", never a name.
 */

export type OrganisationDeps = OrganisationActionDeps & { newId?: () => string };

const refuse = (status: 400 | 403 | 404 | 409 | 429 | 502 | 503, error: string, message?: string): ServiceResult<never> => ({ ok: false, status, error, ...(message ? { message } : {}) });
const nowOf = (deps: OrganisationDeps) => deps.now ?? new Date();
const uidOf = (owner: OrganisationOwner) => owner.person.userId;
const controlOf = (deps: OrganisationDeps): FirestoreLike | undefined => deps.controlDb ?? deps.db;
const brandDbOf = (region: Region, deps: OrganisationDeps): FirestoreLike | undefined => deps.regionDb?.(region) ?? deps.db;

/** A connector an organisation may connect: on in this copy, and shared only when its manifest says how (limits.source). */
function shareableConnector(connectorId: string): ConnectorManifest | null {
  const m = getConnector(connectorId);
  return m && m.api.limits.source ? m : null;
}

/** A refused connect while connecting, for a connector that can't be shared. */
export const NOT_SHAREABLE_MESSAGE = "This connector can't be shared across brands. Connect it for each brand instead.";
/** A pasted token that reaches no zone can't give one to a brand. */
export const ORG_TOKEN_CANT_LIST_MESSAGE =
  "This token can't list its zones, so YouGrow can't give a brand one. Give it Zone Read, or connect it for this brand instead.";

async function recordChange(owner: OrganisationOwner, c: Pick<OrganisationConnection, "id" | "connectedFromTenantId">, kind: OrganisationConnectionChangeKind, at: string, deps: OrganisationDeps): Promise<void> {
  const change = { organisationId: owner.organisation.id, kind, connectionId: c.id, tenantId: c.connectedFromTenantId, actor: uidOf(owner), at };
  const control = controlOf(deps);
  await (control ? recordOrganisationConnectionChange(change, control) : recordOrganisationConnectionChange(change));
}

/** A shared connection's health before Check access first works. */
const notYetChecked = (): OrganisationConnection["health"] => ({ state: "check", lastOkAt: null, lastCheckedAt: null, lastErrorCode: null, failures: 0, pausedUntil: null });

/** A new organisation connection's record, kept in the region of the brand it is connected from. */
function newRecord(owner: OrganisationOwner, m: ConnectorManifest, id: string, method: ConnectMethodName, at: string, rest: Partial<OrganisationConnection>): Omit<OrganisationConnection, "recent"> {
  return {
    id,
    organisationId: owner.organisation.id,
    region: owner.brand.region,
    connectorId: m.id,
    method,
    label: m.name,
    createdBy: uidOf(owner),
    signerUid: null,
    connectedFromTenantId: owner.brand.id,
    secrets: {},
    health: healthyAt(new Date(at)),
    pausedAt: null,
    pausedBy: null,
    status: "connected",
    createdAt: at,
    updatedAt: at,
    disconnectedAt: null,
    collectHold: null,
    parts: [],
    ...rest,
  };
}

// --- Connect ---------------------------------------------------------------------------------

export const OrganisationConnectBodySchema = z
  .object({
    connectorId: z.string().min(1).max(40),
    method: z.enum(["token_fields", "share_access", "oauth_pkce"]),
    fields: z
      .record(z.string().max(64), z.string().max(4096))
      .refine((f) => Object.keys(f).length <= 10, "too many fields")
      .optional(),
    label: z.string().trim().min(1).max(60).optional(),
  })
  .strict();
export type OrganisationConnectBody = z.infer<typeof OrganisationConnectBodySchema>;

export interface OrganisationConnected {
  connectionId: string;
  /** How many zones the token reaches now. */
  reaches: number;
}

/**
 * Connect a pasted token for the organisation (token_fields). Only its secret fields come in: the
 * zones are given to brands later, one each. The token is checked by listing what it reaches (the
 * manifest's accounts hook), rate limited per organisation, and must reach at least one; then it is
 * sealed with the organisation bound in and saved in the region of the brand the owner is in.
 */
export async function connectOrganisationToken(owner: OrganisationOwner, body: OrganisationConnectBody, deps: OrganisationDeps = {}): Promise<ServiceResult<OrganisationConnected>> {
  const m = shareableConnector(body.connectorId);
  if (!m) return getConnector(body.connectorId) ? refuse(400, "not_shareable", NOT_SHAREABLE_MESSAGE) : refuse(404, "not_found");
  const method = tokenMethod(m);
  const hook = method?.pick && m.hooks.accounts ? ACCOUNT_HOOKS[m.hooks.accounts] : undefined;
  if (!method || !hook || !readyMethods(m).includes("token_fields")) return refuse(400, "method_not_supported");
  const fields = checkFields(m, body.fields ?? {}, "secrets");
  if (!fields.ok) return { ok: false, status: 400, error: "invalid_fields", message: `Check ${fields.labels.join(", and ")}.` };
  if (!isVaultConfigured()) return providerRefusal("vault_unconfigured");
  if (!(await organisationTokenCheckRoom(owner.organisation.id, m.id, deps))) return providerRefusal("busy");

  const now = nowOf(deps);
  const id = (deps.newId ?? newOrganisationConnectionId)();
  const token = fields.values[method.auth.field]!;
  const stand = { id, tenantId: owner.organisation.id, pausedAt: null, health: healthyAt(now), source: { organisationId: owner.organisation.id, connectionId: id, region: owner.brand.region } };
  const listed = await hook({ manifest: m, connection: stand, account: "", token }, deps);
  if (!listed.ok) return listed.code === "account_refused" ? refuse(400, "cant_list", ORG_TOKEN_CANT_LIST_MESSAGE) : providerRefusal(listed.code, { name: m.name, chat: isConnectorsChatEnabled() });
  if (!listed.accounts.length) return refuse(400, "cant_list", ORG_TOKEN_CANT_LIST_MESSAGE);

  const at = now.toISOString();
  const secrets: Record<string, SealedSecret> = {};
  for (const f of method.fields) if (f.secret && fields.values[f.key]) secrets[f.key] = sealConnectorSecret(owner.organisation.id, id, f.key, fields.values[f.key]!, now);
  const record = newRecord(owner, m, id, "token_fields", at, { secrets, label: cleanLabel(body.label, m.name) });
  await createOrganisationConnection(record, [{ kind: "connected", by: uidOf(owner), at }], storesOf(deps));
  await recordChange(owner, record, "connection.connected", at, deps);
  return { ok: true, status: 201, value: { connectionId: id, reaches: listed.accounts.length } };
}

export interface OrganisationShareOutcome {
  connectionId: string;
  /** The address to add to each property, the role to give it and where. */
  share: { email: string; role: string; steps: string[] };
  /** True when the organisation already had an address waiting for its first property: no new one was made. */
  reused: boolean;
}

/** A Google address made for the organisation that has never seen a property and serves no brand yet. */
const waitingShare = (c: OrganisationConnection) => c.status === "connected" && c.method === "share_access" && !c.parts.length && !c.health.lastOkAt && Boolean(c.serviceAccount && !c.serviceAccount.deletedAt);

/** The organisation's waiting Google address for a connector, in any region, or null. */
export async function waitingOrganisationShare(organisationId: string, connectorId: string, deps: OrganisationDeps = {}): Promise<OrganisationConnection | null> {
  return (await listOrganisationConnections(organisationId, { connectorId }, storesOf(deps))).find(waitingShare) ?? null;
}

/**
 * Make a Google address for the organisation (share access): its own address in the identities
 * project, tagged for the organisation, never a brand. An address still waiting for its first
 * property comes back instead of a new one. At most SHARE_ADDRESS_CAP per organisation per
 * connector, in every region (org_share_limit), and a few a minute (busy).
 */
export async function shareConnectOrganisation(owner: OrganisationOwner, body: OrganisationConnectBody, deps: OrganisationDeps = {}): Promise<ServiceResult<OrganisationShareOutcome>> {
  const m = shareableConnector(body.connectorId);
  if (!m) return getConnector(body.connectorId) ? refuse(400, "not_shareable", NOT_SHAREABLE_MESSAGE) : refuse(404, "not_found");
  const share = shareMethod(m);
  if (!share || !readyMethods(m).includes("share_access")) return refuse(400, "method_not_supported");
  const project = identitiesProject();
  if (!project) return providerRefusal("share_unconfigured");
  const shareOf = (sa: ConnectionServiceAccount) => ({ email: sa.email, role: share.role, steps: share.steps });

  const waiting = await waitingOrganisationShare(owner.organisation.id, m.id, deps);
  if (waiting) return { ok: true, status: 200, value: { connectionId: waiting.id, share: shareOf(waiting.serviceAccount!), reused: true } };
  const room = await organisationShareRoom(owner.organisation.id, m.id, deps);
  if (!room.ok) return providerRefusal(room.code);

  const now = nowOf(deps);
  const id = (deps.newId ?? newOrganisationConnectionId)();
  const made = await createOrganisationShareAccount(project, owner.organisation.id, id, deps);
  if (!made.ok) return providerRefusal(made.code === "rate_limited" ? "busy" : made.code);
  const at = now.toISOString();
  const serviceAccount: ConnectionServiceAccount = { email: made.account.email, uniqueId: made.account.uniqueId, createdAt: at, deletedAt: null };
  const record = newRecord(owner, m, id, "share_access", at, { serviceAccount, health: notYetChecked(), label: cleanLabel(body.label, m.name) });
  try {
    await createOrganisationConnection(record, [{ kind: "connected", by: uidOf(owner), at }], storesOf(deps));
  } catch (err) {
    // Not saved: delete the address at once. One left behind is found by the organisation purge.
    await deleteShareAccount(project, made.account.uniqueId, deps).catch(() => null);
    throw err;
  }
  await recordChange(owner, record, "connection.connected", at, deps);
  return { ok: true, status: 201, value: { connectionId: id, share: shareOf(serviceAccount), reused: false } };
}

export interface OrganisationAccess {
  /** True when the address sees at least one site or property. */
  visible: boolean;
  /** How many it sees. */
  count: number;
  message: string | null;
}

/** Check access for the organisation's Google address: what it sees now, for giving its parts. Any owner. */
export async function checkOrganisationAccess(owner: OrganisationOwner, sourceId: string, deps: OrganisationDeps = {}): Promise<ServiceResult<OrganisationAccess>> {
  const c = await ownedConnection(owner, sourceId, deps);
  if (!c || c.status !== "connected") return refuse(404, "not_found");
  if (c.method !== "share_access") return refuse(400, "method_not_supported");
  const m = getConnector(c.connectorId);
  if (!m) return refuse(404, "connector_off");
  const hook = m.hooks.accounts ? ACCOUNT_HOOKS[m.hooks.accounts] : undefined;
  if (!hook) return refuse(503, "connector_unavailable");
  const token = await organisationToken(c, m, uidOf(owner), deps);
  if (!token.ok) return token.code === "share_pending" || token.code === "share_access_lost" ? accessOf(false, 0, token.code, m) : providerRefusal(token.code);
  const listed = await hook({ manifest: m, connection: organisationHookConnection(c), account: "", token: token.token }, deps);
  if (!listed.ok && listed.code === "busy") return providerRefusal("busy");
  const outcome = await organisationOutcome(c, listed.ok && listed.accounts.length ? { ok: true } : listed.ok ? { ok: false, code: "share_not_visible", retryAfterSec: null } : listed, uidOf(owner), deps);
  if (!outcome.ok && outcome.code !== "share_not_visible") return providerRefusal(outcome.code);
  return accessOf(outcome.ok, listed.ok ? listed.accounts.length : 0, outcome.ok ? null : outcome.code, m);
}

function accessOf(visible: boolean, count: number, code: ConnectorErrorCode | null, m: ConnectorManifest): ServiceResult<OrganisationAccess> {
  return { ok: true, status: 200, value: { visible, count, message: code ? connectorMessage(code, { name: m.name, chat: isConnectorsChatEnabled() }) : null } };
}

// --- Pause and Disconnect ----------------------------------------------------------------------

/**
 * Pause or resume an organisation's connection: provider calls and collection stop for every brand
 * it serves; numbers already collected stay readable. Resuming also ends a pause after failures.
 * Any owner.
 */
export async function setOrganisationPaused(owner: OrganisationOwner, sourceId: string, paused: boolean, deps: OrganisationDeps = {}): Promise<ServiceResult<{ paused: boolean }>> {
  const c = await ownedConnection(owner, sourceId, deps);
  if (!c || c.status !== "connected") return refuse(404, "not_found");
  const at = nowOf(deps).toISOString();
  const by = uidOf(owner);
  const r = await changeOrganisationConnection(
    c.organisationId,
    c.id,
    c.region,
    (cur) => {
      if (cur.status !== "connected") return null;
      if (paused) return cur.pausedAt ? null : { patch: { pausedAt: at, pausedBy: by, updatedAt: at }, activity: [{ kind: "paused", by, at }] };
      if (!cur.pausedAt && !cur.health.pausedUntil) return null;
      const health = { ...cur.health, pausedUntil: null, failures: 0, state: cur.health.state === "paused" ? ("check" as const) : cur.health.state };
      return { patch: { pausedAt: null, pausedBy: null, health, updatedAt: at }, activity: [{ kind: "resumed", by, at }] };
    },
    storesOf(deps),
  );
  if (!r.ok && r.why === "not_found") return refuse(404, "not_found");
  if (r.ok) await recordChange(owner, c, paused ? "connection.paused" : "connection.resumed", at, deps);
  return { ok: true, status: 200, value: { paused } };
}

export interface OrganisationDisconnectResult {
  /** Brands whose part ended now. */
  ended: number;
  revoked: boolean;
  addressDeleted: boolean | null;
  message: string;
}

/** What Disconnect at the organisation says, from what it did. */
export function organisationDisconnectWords(r: { revoked: boolean; addressDeleted: boolean | null; method: ConnectMethodName; disconnectHint: string | null }): string {
  const lines = ["Disconnected for your organisation. No brand reads it any more, and what YouGrow collected through it is deleted."];
  if (r.revoked) lines.push("YouGrow's access was removed at Google too, so any other connection signed in with the same Google account has to sign in again.");
  else if (r.addressDeleted === true) lines.push("Its Google address was deleted too. Its entry stays in each property's users until you remove it there; it does no harm.");
  else if (r.addressDeleted === false) lines.push("YouGrow couldn't delete its Google address just now and tries again later.");
  else if (r.disconnectHint) lines.push(r.disconnectHint);
  return lines.join(" ");
}

/**
 * Disconnect an organisation's connection: every brand stops reading at once, each brand record
 * is ended and erased in its own region, the Google address is deleted, and a Google sign in is
 * revoked only with CONNECTOR_GOOGLE_REVOKE_ENABLED. Any owner.
 */
export async function disconnectForOrganisation(owner: OrganisationOwner, sourceId: string, deps: OrganisationDeps = {}): Promise<ServiceResult<OrganisationDisconnectResult>> {
  const c = await ownedConnection(owner, sourceId, deps);
  if (!c) return refuse(404, "not_found");
  const r = await disconnectOrganisationConnection(sourceRefOf(c), uidOf(owner), deps);
  if (!r.found) return refuse(404, "not_found");
  if (r.disconnected) await recordChange(owner, c, "connection.disconnected", nowOf(deps).toISOString(), deps);
  const message = organisationDisconnectWords({ revoked: r.revoked, addressDeleted: r.addressDeleted, method: c.method, disconnectHint: knownConnector(c.connectorId)?.disconnect ?? null });
  return { ok: true, status: 200, value: { ended: r.ended, revoked: r.revoked, addressDeleted: r.addressDeleted, message } };
}

// --- What owners see -----------------------------------------------------------------------------

export const regionName = (r: Region): string => REGION_CONFIGS[r]?.displayName ?? r;

/** One of the organisation's brands, as Shared connections and the give dialog show it. */
export interface OrganisationBrandRow {
  id: string;
  name: string;
  region: Region;
  regionName: string;
  /** Its own website, for marking parts that aren't on it. */
  rootDomain: string | null;
  /** The brand the owner is in now. */
  isThis: boolean;
  /** The owner is its admin (isBrandAdminLive), so they may give it a part. */
  isAdmin: boolean;
}

/** A part as its organisation's owners see it, with what its brand's own record says. */
export interface SharedPartView {
  tenantId: string;
  brandName: string;
  region: Region;
  regionName: string;
  account: string;
  state: PartState;
  givenAt: string;
  stateSince: string;
  /** The brand record, read in its region: null when it can't be read now. */
  record: {
    status: DataConnection["status"];
    /** The name it was given with (a zone's or a property's). */
    label: string;
    health: { state: DataConnection["health"]["state"]; lastErrorCode: string | null; since: string | null; lastCheckedAt: string | null };
    grants: ConnectionGrant[];
    pausedAt: string | null;
    collect: CollectView | null;
  } | null;
}

export interface SharedConnectionView {
  id: string;
  connectorId: string;
  connectorName: string;
  connectorIcon?: ConnectorIcon;
  connectorInitials?: string;
  /** False when this copy has the connector switched off. */
  connectorOn: boolean;
  method: ConnectMethodName;
  label: string;
  region: Region;
  regionName: string;
  /** A Google sign in's signer: you, another owner, or someone no longer an owner. Null for the other methods. */
  signer: "you" | "other" | "gone" | null;
  /** This owner sees its list and gives and changes its parts (pick 6): anyone for a token or an address, the signer for a sign in. */
  mine: boolean;
  health: { state: OrganisationConnection["health"]["state"]; lastErrorCode: string | null; since: string | null; lastCheckedAt: string | null };
  pausedAt: string | null;
  /** Paused by this owner, or by another. */
  pausedByYou: boolean;
  collectHold: { until: string; reason: string } | null;
  /** The Google address, for its owners to add to each property; null for the other methods. */
  serviceAccount: { email: string } | null;
  parts: SharedPartView[];
  /** The last brand that stopped using it, by name, and when, from its recent list. */
  stoppedUsing: { brandName: string; at: string } | null;
  /** It has served a brand before (its recent list shows a part given or ended), so no parts now asks to disconnect it. */
  hadParts: boolean;
  createdAt: string;
}

export interface SharedConnectionsScreen {
  organisation: { id: string; name: string };
  /** The brand the owner is in. */
  brand: { id: string; name: string; region: Region; regionName: string };
  connections: SharedConnectionView[];
  /** Every brand in the organisation whose record points back, in every region. */
  brands: OrganisationBrandRow[];
  /** A Google sign in is revoked at Disconnect (CONNECTOR_GOOGLE_REVOKE_ENABLED). */
  revoke: boolean;
  /** Vizzy reads connected data (CONNECTORS_CHAT_ENABLED). */
  chat: boolean;
  /** Numbers are collected (CONNECTORS_COLLECT_ENABLED). */
  collect: boolean;
}

/** At most this many of an organisation's brands are read for one screen, a few at a time. */
const BRANDS_READ = 100;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/**
 * The organisation's brands, read live: each must point back at the organisation (as Plan and
 * usage reads them), and says whether this owner is its admin. A brand that can't be read is left out.
 */
export async function organisationBrands(owner: OrganisationOwner, deps: OrganisationDeps = {}): Promise<OrganisationBrandRow[]> {
  const control = controlOf(deps);
  const ids = owner.organisation.brandIds.slice(0, BRANDS_READ);
  const rows = await mapLimit(ids, 5, async (id): Promise<OrganisationBrandRow | null> => {
    try {
      const t = id === owner.brand.id ? owner.brand : control ? await getTenantById(id, control) : await getTenantById(id);
      if (!t || t.organisationId !== owner.organisation.id) return null;
      const isAdmin = await isBrandAdminLive(owner.person, id, control);
      return { id, name: t.tenantName, region: t.region, regionName: regionName(t.region), rootDomain: t.rootDomain || null, isThis: id === owner.brand.id, isAdmin };
    } catch {
      return null;
    }
  });
  return rows.filter((r): r is OrganisationBrandRow => r !== null);
}

/** A brand record read in its own region; null when missing, another brand's or unreadable now. */
async function partRecord(tenantId: string, region: Region, useId: string, deps: OrganisationDeps): Promise<DataConnection | null> {
  try {
    return await forTenant({ tenantId, region, source: "system" }, brandDbOf(region, deps)).dataConnections.getById(useId);
  } catch {
    return null;
  }
}

/** The signer of a Google sign in, as this owner reads it: you, another owner, or someone no longer an owner. */
export function signerOf(c: Pick<OrganisationConnection, "method" | "signerUid">, owner: Pick<OrganisationOwner, "person" | "organisation">): SharedConnectionView["signer"] {
  if (c.method !== "oauth_pkce") return null;
  if (c.signerUid && c.signerUid === owner.person.userId) return "you";
  return c.signerUid && owner.organisation.ownerIds.includes(c.signerUid) ? "other" : "gone";
}

/** One organisation connection as its owners see it. */
export async function sharedConnectionView(owner: OrganisationOwner, c: OrganisationConnection, brands: readonly OrganisationBrandRow[], deps: OrganisationDeps = {}): Promise<SharedConnectionView> {
  const now = nowOf(deps);
  const known = knownConnector(c.connectorId);
  const named = new Map(brands.map((b) => [b.id, b.name]));
  const parts = await mapLimit(c.parts, 5, async (p): Promise<SharedPartView> => {
    const rec = await partRecord(p.tenantId, p.region, p.useId, deps);
    return {
      tenantId: p.tenantId,
      brandName: named.get(p.tenantId) ?? "A brand that left",
      region: p.region,
      regionName: regionName(p.region),
      account: p.account,
      state: p.state,
      givenAt: p.givenAt,
      stateSince: p.stateSince,
      record:
        rec && rec.source?.connectionId === c.id
          ? {
              status: rec.status,
              label: rec.label,
              health: { state: rec.health.state, lastErrorCode: rec.health.lastErrorCode, since: rec.health.since ?? null, lastCheckedAt: rec.health.lastCheckedAt },
              grants: rec.grants,
              pausedAt: rec.pausedAt,
              collect: isConnectorsCollectEnabled() && rec.status === "connected" ? collectViewOf(rec, now) : null,
            }
          : null,
    };
  });
  const stopped = c.recent.find((e) => e.kind === "part_ended" && e.code === "stopped_using");
  const signer = signerOf(c, owner);
  return {
    id: c.id,
    connectorId: c.connectorId,
    connectorName: known?.name ?? c.connectorId,
    ...(known?.icon ? { connectorIcon: known.icon } : {}),
    ...(known?.initials ? { connectorInitials: known.initials } : {}),
    connectorOn: getConnector(c.connectorId) !== null,
    method: c.method,
    label: c.label,
    region: c.region,
    regionName: regionName(c.region),
    signer,
    mine: c.method !== "oauth_pkce" || signer === "you",
    health: { state: c.health.state, lastErrorCode: c.health.lastErrorCode, since: c.health.since ?? null, lastCheckedAt: c.health.lastCheckedAt },
    pausedAt: c.pausedAt,
    pausedByYou: Boolean(c.pausedBy && c.pausedBy === owner.person.userId),
    collectHold: c.collectHold && Date.parse(c.collectHold.until) > now.getTime() ? { ...c.collectHold } : null,
    serviceAccount: c.method === "share_access" && c.serviceAccount && !c.serviceAccount.deletedAt ? { email: c.serviceAccount.email } : null,
    parts,
    stoppedUsing: stopped ? { brandName: (stopped.tenantId && named.get(stopped.tenantId)) || "A brand", at: stopped.at } : null,
    hadParts: c.recent.some((e) => e.kind === "part_given" || e.kind === "part_ended"),
    createdAt: c.createdAt,
  };
}

/**
 * Settings › Organisation › Shared connections for an owner: the organisation's connected
 * connections from every provisioned region, newest first, and its brands. A region that can't be
 * read throws, so the screen says it couldn't load rather than showing fewer.
 */
export async function sharedConnectionsScreen(owner: OrganisationOwner, deps: OrganisationDeps = {}): Promise<SharedConnectionsScreen> {
  const [all, brands] = await Promise.all([listOrganisationConnections(owner.organisation.id, {}, storesOf(deps)), organisationBrands(owner, deps)]);
  const connected = all.filter((c) => c.status === "connected");
  const connections = await mapLimit(connected, 3, (c) => sharedConnectionView(owner, c, brands, deps));
  return {
    organisation: { id: owner.organisation.id, name: owner.organisation.name },
    brand: { id: owner.brand.id, name: owner.brand.tenantName, region: owner.brand.region, regionName: regionName(owner.brand.region) },
    connections,
    brands,
    revoke: isGoogleRevokeEnabled(),
    chat: isConnectorsChatEnabled(),
    collect: isConnectorsCollectEnabled(),
  };
}

/** One of the organisation's connections as its owners see it, or 404. */
export async function sharedConnectionFor(owner: OrganisationOwner, sourceId: string, deps: OrganisationDeps = {}): Promise<ServiceResult<SharedConnectionView>> {
  const c = await ownedConnection(owner, sourceId, deps);
  if (!c || c.status !== "connected") return refuse(404, "not_found");
  return { ok: true, status: 200, value: await sharedConnectionView(owner, c, await organisationBrands(owner, deps), deps) };
}

/** What a connector's Listing needs to offer "Connect for" the organisation. */
export interface OrganisationListing {
  id: string;
  name: string;
  /** The brand the owner is in, and the region a connection made now is kept in. */
  brandName: string;
  regionName: string;
  /** The connector can be shared (its manifest says how). */
  shareable: boolean;
  /** The organisation's Google address for this connector still waiting for its first property, or null. */
  waitingShare: { id: string; email: string } | null;
}

/** "Connect for" on a Listing, for an owner: the organisation, where a sign in is kept, and a waiting address. */
export async function organisationListing(owner: OrganisationOwner, connectorId: string, deps: OrganisationDeps = {}): Promise<OrganisationListing> {
  const m = shareableConnector(connectorId);
  const waiting = m ? await waitingOrganisationShare(owner.organisation.id, m.id, deps).catch(() => null) : null;
  return {
    id: owner.organisation.id,
    name: owner.organisation.name,
    brandName: owner.brand.tenantName,
    regionName: regionName(owner.brand.region),
    shareable: Boolean(m),
    waitingShare: waiting?.serviceAccount ? { id: waiting.id, email: waiting.serviceAccount.email } : null,
  };
}
