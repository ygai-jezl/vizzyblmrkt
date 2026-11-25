import { randomBytes } from "node:crypto";
import { z } from "zod";
import { changePart, forTenant, getTenantById, givePart, isBrandAdminLive, listOrganisationConnections, type BrandRef, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { freshCollect, type ConnectionGrant, type DataConnection } from "@/lib/types/dataConnection";
import type { OrganisationConnection } from "@/lib/types/organisationConnection";
import type { Region, Tenant } from "@/lib/types/tenant";
import { normaliseGrants } from "./grants";
import { ACCOUNT_HOOKS, VERIFY_HOOKS } from "./handlers";
import type { ConnectorAccount } from "./handlers/types";
import { healthyAt } from "./health";
import type { ConnectorManifest } from "./manifest";
import { productName } from "./messages";
import { endOnePart } from "./organisation";
import { organisationBrands, type OrganisationDeps } from "./organisationConnect";
import { organisationHookConnection, organisationOutcome, organisationToken, ownedConnection, sourceRefOf, type OrganisationOwner } from "./organisationOwner";
import { getConnector } from "./registry";
import { afterChangeProperty, changePropertyPlan, cleanLabel, newDataConnectionId, providerRefusal, type ServiceResult } from "./service";
import { storesOf } from "./sources";

/**
 * Giving, changing and taking back a brand's part (Connectors 3, ADR-0015), for owners on
 * Settings › Organisation. The part a brand is given is YouGrow's own wall: one token can read
 * every part its identity sees, so the server checks everything itself.
 *
 * To give a brand a part, or change one, the owner (checked live by the route) must also be:
 * - an admin of that brand, read live (isBrandAdminLive);
 * - for a Google sign in, the owner who signed in: only they see its list (pick 6).
 * And the brand must be in the organisation both ways (the organisation lists it and its own
 * record points back), read now, with its region from its registry record, never the request; it
 * must hold no part of this connection; the part must not be given through any of the
 * organisation's connections for this connector, in any region; and the sign in must read the
 * part now (the connector's verify request with the organisation's token). Then the three steps
 * over two databases run in src/lib/tenant/organisationConnections.ts. The brand's own connection
 * to the same part refuses the give in its second step.
 *
 * Taking a part back is any owner's: it ends the brand record and erases what it collected, never
 * revokes and never deletes the Google address, which other brands may still use.
 */

const refuse = (status: 400 | 403 | 404 | 409 | 429 | 502 | 503, error: string, message?: string): ServiceResult<never> => ({ ok: false, status, error, ...(message ? { message } : {}) });
const nowOf = (deps: OrganisationDeps) => deps.now ?? new Date();
const uidOf = (owner: OrganisationOwner) => owner.person.userId;
const controlOf = (deps: OrganisationDeps): FirestoreLike | undefined => deps.controlDb ?? deps.db;
const brandDbOf = (region: Region, deps: OrganisationDeps): FirestoreLike | undefined => deps.regionDb?.(region) ?? deps.db;

/** What a part of a connector is called, in a sentence. */
export function partNoun(connectorId: string): string {
  return connectorId === "search-console" ? "site" : connectorId === "google-analytics" ? "property" : connectorId === "cloudflare" ? "zone" : "part";
}

export const SIGNER_ONLY_MESSAGE = "Only the owner who signed in can see its list and give its parts. You can take one back, pause, disconnect, or sign in again yourself.";
export const NOT_IN_ORGANISATION_MESSAGE = "That brand isn't in your organisation any more. Reload the page.";
export const PART_GIVEN_MESSAGE = "That one is given to a brand already. Take it back there first.";
export const HAS_PART_MESSAGE = "That brand has a part from this connection already. Change it instead.";
export const ACCOUNT_REFUSED_MESSAGE = "That isn't one this connection can read now. Pick one from the list.";
export const GONE_MESSAGE = "The connection changed while this was being given. Try again.";
export const notBrandAdminMessage = (brand: string) => `You're not an admin of ${brand}, so you can't give it a part. Ask one of its admins to add you to its team.`;
export const ownConnectionMessage = (brand: string, connectorName: string, one: string) => `${brand} already has its own ${productName(connectorName)} connection to this ${one}. Disconnect that one first.`;

/** One thing the organisation's connection can see, with whom it is given to already. */
export interface OrganisationAccount extends ConnectorAccount {
  /** Given through this connection, and to which brand. */
  givenTo: { tenantId: string } | null;
  /** Given through another of the organisation's connections for this connector, in any region. */
  givenElsewhere: { tenantId: string } | null;
  /**
   * How many of the organisation's brands read it with their own connection. Only the ones the
   * owner is an admin of come by id (`ownAdminBrandIds`, the brands they could give it to): any other
   * brand's own setting stays its own, so the dialog warns without naming it (pick 13).
   */
  ownCount: number;
  ownAdminBrandIds: string[];
}

export interface OrganisationAccountsList {
  accounts: OrganisationAccount[];
  /** The provider listed more than the dialog shows. */
  more: boolean;
}

/** The parts every one of the organisation's connections for a connector gives out, in any region. */
async function givenAcross(owner: OrganisationOwner, connectorId: string, deps: OrganisationDeps): Promise<Array<{ connectionId: string; tenantId: string; account: string }>> {
  const all = await listOrganisationConnections(owner.organisation.id, { connectorId }, storesOf(deps));
  return all.flatMap((c) => c.parts.flatMap((p) => [{ connectionId: c.id, tenantId: p.tenantId, account: p.account }, ...(p.was ? [{ connectionId: c.id, tenantId: p.tenantId, account: p.was }] : [])]));
}

/**
 * The parts the organisation's connection can see now, for the give dialog: its token lists them
 * (the manifest's accounts hook, Cloudflare's zones included), each marked when it is given already
 * here or through another of the organisation's connections, and with how many of the organisation's
 * brands read it with their own connection (named by id only where the owner is that brand's
 * admin). For a Google sign in, only its signer may list it.
 */
export async function listOrganisationAccounts(owner: OrganisationOwner, sourceId: string, deps: OrganisationDeps = {}): Promise<ServiceResult<OrganisationAccountsList>> {
  const c = await ownedConnection(owner, sourceId, deps);
  if (!c || c.status !== "connected") return refuse(404, "not_found");
  const m = getConnector(c.connectorId);
  if (!m) return refuse(404, "connector_off");
  if (c.method === "oauth_pkce" && c.signerUid !== uidOf(owner)) return refuse(403, "signer_only", SIGNER_ONLY_MESSAGE);
  const hook = m.hooks.accounts ? ACCOUNT_HOOKS[m.hooks.accounts] : undefined;
  if (!hook) return refuse(503, "connector_unavailable");
  const token = await organisationToken(c, m, uidOf(owner), deps);
  if (!token.ok) return providerRefusal(token.code);
  const listed = await hook({ manifest: m, connection: organisationHookConnection(c), account: "", token: token.token }, deps);
  if (!listed.ok && listed.code === "busy") return providerRefusal("busy");
  const outcome = await organisationOutcome(c, listed.ok ? { ok: true } : listed, uidOf(owner), deps);
  if (!outcome.ok || !listed.ok) return providerRefusal(outcome.ok ? "bad_response" : outcome.code);

  const [given, brands] = await Promise.all([givenAcross(owner, c.connectorId, deps), organisationBrands(owner, deps)]);
  // Each brand's own connections to this connector, read in its own region (equality only).
  const own = new Map<string, Array<{ id: string; isAdmin: boolean }>>();
  for (const b of brands) {
    const rows = await forTenant({ tenantId: b.id, region: b.region, source: "system" }, brandDbOf(b.region, deps))
      .dataConnections.find({ where: [["connectorId", "==", c.connectorId], ["status", "==", "connected"]], limit: 50 })
      .catch(() => [] as DataConnection[]);
    for (const r of rows) if (!r.source && r.account) own.set(r.account, [...(own.get(r.account) ?? []), { id: b.id, isAdmin: b.isAdmin }]);
  }
  const accounts = listed.accounts.map((a): OrganisationAccount => {
    const here = given.find((g) => g.account === a.id && g.connectionId === c.id);
    const elsewhere = here ? undefined : given.find((g) => g.account === a.id);
    const readers = own.get(a.id) ?? [];
    return {
      ...a,
      givenTo: here ? { tenantId: here.tenantId } : null,
      givenElsewhere: elsewhere ? { tenantId: elsewhere.tenantId } : null,
      ownCount: readers.length,
      ownAdminBrandIds: readers.filter((r) => r.isAdmin).map((r) => r.id),
    };
  });
  return { ok: true, status: 200, value: { accounts, more: listed.more } };
}

/** The brand an owner names, checked on the server: in the organisation both ways, not suspended, and its region from its own record. */
async function targetBrand(owner: OrganisationOwner, tenantId: string, deps: OrganisationDeps): Promise<Tenant | null> {
  if (!owner.organisation.brandIds.includes(tenantId)) return null;
  const control = controlOf(deps);
  const t = tenantId === owner.brand.id ? owner.brand : control ? await getTenantById(tenantId, control) : await getTenantById(tenantId);
  return t && t.status !== "suspended" && t.organisationId === owner.organisation.id ? t : null;
}

type Checked = { ok: true; c: OrganisationConnection; m: ConnectorManifest; brand: Tenant; token: string } | { ok: false; result: ServiceResult<never> };

/** Every check giving or changing a part makes before it writes anything. */
async function checkGive(owner: OrganisationOwner, sourceId: string, tenantId: string, account: string, deps: OrganisationDeps, opts: { changing?: string } = {}): Promise<Checked> {
  const no = (result: ServiceResult<never>): Checked => ({ ok: false, result });
  const c = await ownedConnection(owner, sourceId, deps);
  if (!c || c.status !== "connected") return no(refuse(404, "not_found"));
  const m = getConnector(c.connectorId);
  if (!m || !m.api.limits.source) return no(refuse(404, "connector_off"));
  if (c.method === "oauth_pkce" && c.signerUid !== uidOf(owner)) return no(refuse(403, "signer_only", SIGNER_ONLY_MESSAGE));
  const brand = await targetBrand(owner, tenantId, deps);
  if (!brand) return no(refuse(404, "not_in_organisation", NOT_IN_ORGANISATION_MESSAGE));
  if (!(await isBrandAdminLive(owner.person, brand.id, controlOf(deps)))) return no(refuse(403, "not_brand_admin", notBrandAdminMessage(brand.tenantName)));
  const held = c.parts.find((p) => p.tenantId === brand.id);
  if (!opts.changing && held) return no(refuse(409, "has_part", HAS_PART_MESSAGE));
  if (opts.changing && !held) return no(refuse(404, "no_part"));
  const given = await givenAcross(owner, c.connectorId, deps);
  if (given.some((g) => g.account === account && !(g.connectionId === c.id && g.tenantId === brand.id))) return no(refuse(409, "part_given", PART_GIVEN_MESSAGE));
  const token = await organisationToken(c, m, uidOf(owner), deps);
  if (!token.ok) return no(providerRefusal(token.code));
  const verify = VERIFY_HOOKS[m.verify.hook];
  if (!verify) return no(refuse(503, "connector_unavailable"));
  const checked = await verify({ manifest: m, connection: organisationHookConnection(c), account, token: token.token }, deps);
  if (!checked.ok && checked.code === "busy") return no(providerRefusal("busy"));
  const outcome = await organisationOutcome(c, checked, uidOf(owner), deps);
  if (!outcome.ok) return no(outcome.code === "account_refused" || outcome.code === "share_not_visible" ? refuse(400, "account_refused", ACCOUNT_REFUSED_MESSAGE) : providerRefusal(outcome.code));
  return { ok: true, c, m, brand, token: token.token };
}

export const GiveBodySchema = z
  .object({
    tenantId: z.string().min(1).max(128),
    account: z.string().trim().min(1).max(2000),
    /** The part's name as the list showed it, kept as the brand record's label. */
    label: z.string().trim().min(1).max(200).optional(),
    members: z.boolean(),
    vizzy: z.boolean(),
  })
  .strict();

export interface GivenPart {
  /** The brand record made for the part, in the brand's own region. */
  connectionId: string;
  /** False when the last step couldn't be written: housekeeping finishes it, and it reads nothing until then. */
  active: boolean;
}

/**
 * Give a brand one part of the organisation's connection, with the readers the owner ticked for
 * that brand. Its numbers start on the lane's next run, 90 days filled in its own region.
 */
export async function givePartTo(owner: OrganisationOwner, sourceId: string, body: unknown, deps: OrganisationDeps = {}): Promise<ServiceResult<GivenPart>> {
  const parsed = GiveBodySchema.safeParse(body);
  if (!parsed.success) return refuse(400, "invalid_input");
  const { tenantId, account } = parsed.data;
  const checked = await checkGive(owner, sourceId, tenantId, account, deps);
  if (!checked.ok) return checked.result;
  const { c, m, brand } = checked;
  const now = nowOf(deps);
  const at = now.toISOString();
  const by = uidOf(owner);
  const grants: ConnectionGrant[] = normaliseGrants([
    ...(parsed.data.members ? [{ to: "members" as const, can: "read" as const }] : []),
    ...(parsed.data.vizzy ? [{ to: "agent:vizzy" as const, can: "read" as const }] : []),
  ]);
  const brandRef: BrandRef = { tenantId: brand.id, region: brand.region };
  const r = await givePart(
    {
      source: sourceRefOf(c),
      brand: brandRef,
      record: {
        id: (deps.newId ?? newDataConnectionId)(),
        connectorId: c.connectorId,
        method: c.method,
        label: cleanLabel(parsed.data.label, m.name),
        account,
        ownerUid: by,
        grants,
        secrets: {},
        health: healthyAt(now),
        pausedAt: null,
        pausedBy: null,
        status: "connected",
        createdAt: at,
        updatedAt: at,
        disconnectedAt: null,
        // Collected numbers start on the lane's next run (CONNECTORS_COLLECT_ENABLED).
        collect: freshCollect(at),
      },
      recordActivity: [{ kind: "connected", by, at, code: "part_given" }],
      by,
      at,
    },
    storesOf(deps),
  );
  if (r.ok) return { ok: true, status: 201, value: { connectionId: r.connection.id, active: r.active } };
  if (r.why === "own_connection") return refuse(409, "own_connection", ownConnectionMessage(brand.tenantName, m.name, partNoun(m.id)));
  if (r.why === "has_part") return refuse(409, "has_part", HAS_PART_MESSAGE);
  if (r.why === "part_given") return refuse(409, "part_given", PART_GIVEN_MESSAGE);
  if (r.why === "too_many") return refuse(409, "too_many", "This connection gives out as many parts as it can. Take one back first.");
  if (r.why === "not_found") return refuse(404, "not_found");
  return refuse(409, String(r.why), GONE_MESSAGE);
}

export const ChangeBodySchema = z
  .object({ tenantId: z.string().min(1).max(128), account: z.string().trim().min(1).max(2000), label: z.string().trim().min(1).max(200).optional() })
  .strict();

/**
 * Change a brand's part (for a Google sign in, only its signer): Change property for that brand,
 * in three steps. The brand stops reading the old part at once; its numbers from the old part are
 * erased, and 90 days fill again from the new one.
 */
export async function changePartOf(owner: OrganisationOwner, sourceId: string, body: unknown, deps: OrganisationDeps = {}): Promise<ServiceResult<{ connectionId: string; active: boolean }>> {
  const parsed = ChangeBodySchema.safeParse(body);
  if (!parsed.success) return refuse(400, "invalid_input");
  const { tenantId, account } = parsed.data;
  const checked = await checkGive(owner, sourceId, tenantId, account, deps, { changing: account });
  if (!checked.ok) return checked.result;
  const { c, m, brand } = checked;
  const part = c.parts.find((p) => p.tenantId === brand.id)!;
  if (part.account === account) return refuse(409, "same", "That is the one it reads now.");
  const now = nowOf(deps);
  const at = now.toISOString();
  const by = uidOf(owner);
  const leaseId = randomBytes(12).toString("hex");
  let leased = false;
  let erase: number[] | null = null;
  const brandRef: BrandRef = { tenantId: brand.id, region: brand.region };
  const label = parsed.data.label ? cleanLabel(parsed.data.label, m.name) : m.name;
  const r = await changePart(
    {
      source: sourceRefOf(c),
      brand: brandRef,
      useId: part.useId,
      account,
      by,
      at,
      plan: (cur) => {
        const planned = changePropertyPlan(cur, account, { now, by, leaseId, code: "part_changed", label });
        leased = planned?.kind === "leased";
        erase = planned?.kind === "plan" ? planned.erase : null;
        return planned?.kind === "plan" ? planned.plan : null;
      },
    },
    storesOf(deps),
  );
  if (!r.ok) {
    if (leased) return providerRefusal("busy");
    if (r.why === "busy") return refuse(409, "busy", "This part is being given, changed or taken back already. Try again in a minute.");
    if (r.why === "part_given") return refuse(409, "part_given", PART_GIVEN_MESSAGE);
    if (r.why === "not_found" || r.why === "no_part") return refuse(404, "no_part");
    return refuse(409, String(r.why), GONE_MESSAGE);
  }
  const old = erase as number[] | null;
  const ctx: TenantContext = { tenantId: brand.id, region: brand.region, source: "system" };
  if (old) await afterChangeProperty(ctx, part.useId, r.connection, old, leaseId, { by, now, db: brandDbOf(brand.region, deps), searchIndex: deps.searchIndex });
  return { ok: true, status: 200, value: { connectionId: part.useId, active: r.active } };
}

export const TakeBackBodySchema = z.object({ tenantId: z.string().min(1).max(128) }).strict();

/** What Take back says for a Google address: the address can still read the part until the customer removes it. */
export function addressStillReadsMessage(account: string, connectorName: string, one: string): string {
  return `YouGrow's address can still read ${account}. Remove it in ${productName(connectorName)} if no brand uses that ${one}.`;
}

/**
 * Take a brand's part back, any owner: the brand stops reading it now, its record ends and what it
 * collected is erased in its own region. Never revokes, never deletes the Google address.
 */
export async function takeBackPart(owner: OrganisationOwner, sourceId: string, body: unknown, deps: OrganisationDeps = {}): Promise<ServiceResult<{ ended: boolean; message: string | null }>> {
  const parsed = TakeBackBodySchema.safeParse(body);
  if (!parsed.success) return refuse(400, "invalid_input");
  const c = await ownedConnection(owner, sourceId, deps);
  if (!c) return refuse(404, "not_found");
  const part = c.parts.find((p) => p.tenantId === parsed.data.tenantId);
  if (!part) return refuse(404, "no_part");
  const ended = await endOnePart(sourceRefOf(c), { tenantId: part.tenantId, region: part.region }, part.useId, { by: uidOf(owner), code: "part_ended" }, deps);
  const name = getConnector(c.connectorId)?.name ?? c.connectorId;
  return { ok: true, status: 200, value: { ended, message: c.method === "share_access" ? addressStillReadsMessage(part.account, name, partNoun(c.connectorId)) : null } };
}
