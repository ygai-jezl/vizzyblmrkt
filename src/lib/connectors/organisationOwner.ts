import { changeOrganisationConnection, findOrganisationConnection, isBrandAdminLive, organisationContextFor, type SourceRef, type TenantContext, type VerifiedPerson } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Organisation } from "@/lib/types/organisation";
import type { OrganisationConnection } from "@/lib/types/organisationConnection";
import type { Tenant } from "@/lib/types/tenant";
import type { HookFailure, HookInput } from "./handlers/types";
import { healthAfterSuccess, isCallPaused } from "./health";
import { shareMethod, tokenMethod, type ConnectorManifest } from "./manifest";
import type { ConnectorErrorCode } from "./messages";
import { identitiesProject, shareAccessToken } from "./shareAccess";
import { markSourceBroken, storesOf, type SourceDeps } from "./sources";
import { keepFresh, organisationKeeperPort } from "./tokenKeeper";
import { openConnectorSecret, VaultOpenError } from "./vault";

/**
 * Who acts for an organisation, and with what (Connectors 3, ADR-0014): the owner check every
 * organisation route makes after the integrations gate, and the organisation connection's own
 * token for the calls only its owners make (listing what it can see, checking a part before it is
 * given or changed, checking access).
 *
 * - An owner is in the organisation's `ownerIds`, read live, and an admin of the brand they are in
 *   (isBrandAdminLive), read live too. The organisation is the one the session brand's own
 *   registry record names; it never comes from a request.
 * - A request names an organisation connection by id only. It is found in each provisioned region
 *   on the server and refused unless it is this organisation's (findOrganisationConnection).
 * - The organisation's token is minted from its own record: a Google address's short lived token,
 *   a Google sign in kept fresh on the organisation's record (its lease and health written there),
 *   or a pasted token opened with the organisation bound in. A failure of the sign in itself marks
 *   the organisation's record; nothing here touches a brand's record.
 */

export interface OrganisationOwner {
  /** The brand the person is in, from the session: they are its admin. */
  ctx: TenantContext;
  person: VerifiedPerson;
  organisation: Organisation;
  /** The session brand's registry record, read live. */
  brand: Tenant;
}

export type OwnerCheck = { ok: true; owner: OrganisationOwner } | { ok: false; why: "no_organisation" | "not_owner" | "not_admin" };

const controlOf = (deps: Pick<SourceDeps, "db" | "controlDb">): FirestoreLike | undefined => deps.controlDb ?? deps.db;

/**
 * The person as an owner of the organisation of the brand they are in, read live: none when the
 * brand has no organisation (or plans read none), not an owner, or not an admin of this brand.
 */
export async function organisationOwnerOf(ctx: TenantContext, person: VerifiedPerson, deps: Pick<SourceDeps, "db" | "controlDb"> = {}): Promise<OwnerCheck> {
  const control = controlOf(deps);
  const org = await organisationContextFor(ctx, control);
  if (!org) return { ok: false, why: "no_organisation" };
  if (!org.isOwner) return { ok: false, why: "not_owner" };
  if (!(await isBrandAdminLive(person, ctx.tenantId, control))) return { ok: false, why: "not_admin" };
  return { ok: true, owner: { ctx, person, organisation: org.organisation, brand: org.brand } };
}

/** An organisation connection by id, wherever it is kept, if it is this owner's organisation's. */
export async function ownedConnection(owner: OrganisationOwner, sourceId: string, deps: SourceDeps = {}): Promise<OrganisationConnection | null> {
  return findOrganisationConnection(owner.organisation.id, sourceId, storesOf(deps));
}

export const sourceRefOf = (c: Pick<OrganisationConnection, "organisationId" | "id" | "region">): SourceRef => ({ organisationId: c.organisationId, connectionId: c.id, region: c.region });

/**
 * What a hook is told about the connection for a call made with the organisation's own token: the
 * organisation's record, so safe fetch counts the call in its organisation connection's budget
 * (and under the organisation, never under the brand an owner acts from), and its pause holds.
 */
export function organisationHookConnection(c: OrganisationConnection): HookInput["connection"] {
  return { id: c.id, tenantId: c.organisationId, pausedAt: c.pausedAt, health: c.health, source: { organisationId: c.organisationId, connectionId: c.id, region: c.region } };
}

export type OrganisationTokenResult = { ok: true; token: string } | { ok: false; code: ConnectorErrorCode; retryAfterSec: number | null };

/**
 * The organisation connection's own token, for its owners' calls. Refused while it is paused or
 * disconnected. A Google address IAM can't find any more, a secret that won't open, and Google
 * ending a sign in mark the organisation's record (the token keeper writes the last itself).
 */
export async function organisationToken(c: OrganisationConnection, manifest: ConnectorManifest, by: string, deps: SourceDeps = {}): Promise<OrganisationTokenResult> {
  const now = deps.now ?? new Date();
  const fail = (code: ConnectorErrorCode, retryAfterSec: number | null = null): OrganisationTokenResult => ({ ok: false, code, retryAfterSec });
  if (c.status !== "connected") return fail("disconnected");
  if (isCallPaused(c, now)) return fail("paused");
  const ref = sourceRefOf(c);

  if (c.method === "share_access") {
    const share = shareMethod(manifest);
    const sa = c.serviceAccount;
    if (!share || !identitiesProject()) return fail("share_unconfigured");
    if (!sa || sa.deletedAt) return fail("disconnected");
    const r = await shareAccessToken(sa, share.scopes[0]!, deps);
    if (r.ok) return { ok: true, token: r.token };
    if ("gone" in r && r.gone) {
      await markSourceBroken(ref, "share_access_lost", by, deps);
      return fail("share_access_lost");
    }
    return fail(r.code, r.retryAfterSec);
  }

  if (c.method === "oauth_pkce") {
    const kept = await keepFresh(organisationKeeperPort(ref, storesOf(deps)), c, by, deps);
    if (kept.ok) return { ok: true, token: kept.token };
    if (kept.code === "secret_unopenable") await markSourceBroken(ref, "secret_unopenable", by, deps);
    return fail(kept.code, kept.retryAfterSec);
  }

  const method = tokenMethod(manifest);
  const sealed = method ? c.secrets[method.auth.field] : undefined;
  try {
    if (!sealed) throw new VaultOpenError("unopenable");
    return { ok: true, token: openConnectorSecret(c.organisationId, c.id, method!.auth.field, sealed) };
  } catch (err) {
    if (!(err instanceof VaultOpenError)) throw err;
    await markSourceBroken(ref, "secret_unopenable", by, deps);
    return fail("secret_unopenable");
  }
}

/** The codes that say a call with a Google address couldn't see what it asked for, in share access's own words. */
const SHARE_NOT_VISIBLE: ReadonlySet<ConnectorErrorCode> = new Set(["account_refused", "token_refused", "signin_refused"]);

/**
 * A call made with the organisation's own token, in the organisation's words: a Google address
 * that can't see something can't see it (share_not_visible), never a broken sign in; a pasted
 * token turned down outright, or Google ending a sign in, marks the organisation's record.
 */
export async function organisationOutcome(c: OrganisationConnection, outcome: { ok: true } | HookFailure, by: string, deps: SourceDeps = {}): Promise<{ ok: true } | HookFailure> {
  const ref = sourceRefOf(c);
  if (outcome.ok) {
    const now = deps.now ?? new Date();
    const recent = c.health.state === "ok" && c.health.lastOkAt && now.getTime() - Date.parse(c.health.lastOkAt) < 10 * 60_000;
    if (!recent) {
      await changeOrganisationConnection(
        c.organisationId,
        c.id,
        c.region,
        (cur) => (cur.status === "connected" ? { patch: { health: healthAfterSuccess(cur.health, now) }, activity: [] } : null),
        storesOf(deps),
      ).catch(() => null);
    }
    return outcome;
  }
  if (c.method === "share_access") return SHARE_NOT_VISIBLE.has(outcome.code) ? { ...outcome, code: "share_not_visible" } : outcome;
  if (outcome.code === "token_refused" || (c.method === "oauth_pkce" && outcome.code === "signin_refused")) await markSourceBroken(ref, outcome.code, by, deps);
  return outcome;
}
