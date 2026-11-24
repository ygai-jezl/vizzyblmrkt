import { isRateLimited, listOrganisationConnections } from "@/lib/tenant";
import type { OrganisationConnection } from "@/lib/types/organisationConnection";
import type { ConnectorErrorCode } from "./messages";
import { SHARE_ADDRESS_CAP } from "./service";
import { storesOf, type SourceDeps } from "./sources";
import type { ConnectorFetchDeps } from "./safeFetch";

/**
 * An organisation's own connections (Connectors 3, ADR-0014), at the organisation's level: what the
 * organisation may hold and make, counted per organisation in every region, never per brand.
 *
 * - Google addresses: at most SHARE_ADDRESS_CAP (5) per organisation per connector, counting those
 *   still connected and the disconnected ones whose address a failed delete left at Google, in every
 *   provisioned region. The identities project's service account quota is shared by every brand and
 *   organisation of a copy, and this cap is what stops one organisation filling it.
 * - Making an address and checking a pasted token are rate limited per organisation
 *   (`connector-share-org:` and `connector-check-org:`), whichever brand an owner acts from.
 */

export interface OrganisationDeps extends SourceDeps, Pick<ConnectorFetchDeps, "limit"> {}

/** New Google addresses one organisation may make for one connector: a few a minute, ten an hour. */
export const ORG_SHARE_CREATE_LIMIT = { burst: 3, hourly: 10 };
/** Token checks one organisation may make for one connector. */
export const ORG_TOKEN_CHECK_LIMIT = { burst: 5, hourly: 30 };

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

/** Whether the organisation may check another pasted token for a connector now (busy when not). */
export async function organisationTokenCheckRoom(organisationId: string, connectorId: string, deps: OrganisationDeps = {}): Promise<boolean> {
  return !(await limitOf(deps)(organisationId, { prefix: `connector-check-org:${connectorId}`, burstLimit: ORG_TOKEN_CHECK_LIMIT.burst, hourlyLimit: ORG_TOKEN_CHECK_LIMIT.hourly }));
}
