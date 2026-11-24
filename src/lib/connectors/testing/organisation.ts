import { createOrganisationConnection, givePart, type NewOrganisationConnection, type SourceRef } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { ConnectionGrant, DataConnection } from "@/lib/types/dataConnection";
import type { Region } from "@/lib/types/tenant";

/**
 * A made-up organisation for tests of shared connections (Connectors 3): one fake database per
 * region, with (default), the control database, being the United States one as in production.
 * Fernhill Group owns Fernhill Plants (Europe) and Fernhill US (United States); Priya is its owner.
 */
export interface OrgWorld {
  us: FakeFirestore;
  eu: FakeFirestore;
  asia: FakeFirestore;
  regionDb: (region: Region) => FakeFirestore;
}

export const ORG = "org_ten_fernhill";
export const OTHER_ORG = "org_ten_other";
export const EU_BRAND = { tenantId: "ten_fernhill", region: "eu" as Region };
export const US_BRAND = { tenantId: "ten_fernhill-us", region: "us" as Region };
export const OCN = "ocn_aaaaaaaaaaaaaaaaaaaa";
export const USE_US = "dcn_uuuuuuuuuuuuuuuuuuuu";
export const USE_EU = "dcn_eeeeeeeeeeeeeeeeeeee";
export const T0 = "2026-11-24T10:00:00.000Z";

export function orgWorld(): OrgWorld {
  const us = new FakeFirestore();
  const eu = new FakeFirestore();
  const asia = new FakeFirestore();
  return { us, eu, asia, regionDb: (r) => (r === "eu" ? eu : r === "asia" ? asia : us) };
}

/** The deps a brand's service call takes: its own region's database, the control one and every region's. */
export function brandDeps(world: OrgWorld, brand: { region: Region }) {
  return { db: world.regionDb(brand.region), controlDb: world.us, regionDb: world.regionDb };
}

export function seedTenant(world: OrgWorld, brand: { tenantId: string; region: Region }, organisationId: string | null, over: Record<string, unknown> = {}): void {
  world.us.seed("tenants", brand.tenantId, {
    tenantName: brand.tenantId === EU_BRAND.tenantId ? "Fernhill Plants" : brand.tenantId === US_BRAND.tenantId ? "Fernhill US" : brand.tenantId,
    rootDomain: `${brand.tenantId}.example`,
    ownerId: "usr_priya",
    status: "active",
    region: brand.region,
    allowedOrigins: [],
    createdAt: T0,
    updatedAt: T0,
    ...(organisationId ? { organisationId } : {}),
    ...over,
  });
}

export function seedOrganisation(world: OrgWorld, id: string, brandIds: string[], ownerIds: string[] = ["usr_priya"], name = "Fernhill Group"): void {
  world.us.seed("organisations", id, { name, plan: "ultra", planSince: T0, brandIds, ownerIds, createdBy: "usr_priya", createdAt: T0, updatedAt: T0 });
}

/** Fernhill Group with both brands, its owner Priya, and nothing connected yet. */
export function seedFernhill(world: OrgWorld): void {
  seedTenant(world, EU_BRAND, ORG);
  seedTenant(world, US_BRAND, ORG);
  seedOrganisation(world, ORG, [EU_BRAND.tenantId, US_BRAND.tenantId]);
}

const health = { state: "ok" as const, lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null };

/** An organisation connection, kept in Europe (connected from Fernhill Plants), with no parts. */
export async function seedSource(world: OrgWorld, over: Partial<NewOrganisationConnection> = {}): Promise<SourceRef> {
  const conn: NewOrganisationConnection = {
    id: OCN,
    organisationId: ORG,
    region: "eu",
    connectorId: "cloudflare",
    method: "token_fields",
    label: "Cloudflare",
    createdBy: "usr_priya",
    signerUid: null,
    connectedFromTenantId: EU_BRAND.tenantId,
    secrets: {},
    health,
    pausedAt: null,
    pausedBy: null,
    status: "connected",
    createdAt: T0,
    updatedAt: T0,
    disconnectedAt: null,
    collectHold: null,
    parts: [],
    ...over,
  };
  await createOrganisationConnection(conn, [{ kind: "connected", by: "usr_priya", at: T0 }], { regionDb: world.regionDb });
  return { organisationId: conn.organisationId, connectionId: conn.id, region: conn.region };
}

/** Give a brand a part through the three steps, as an owner would. */
export async function seedPart(
  world: OrgWorld,
  source: SourceRef,
  brand: { tenantId: string; region: Region },
  opts: { useId: string; account: string; connectorId?: string; method?: DataConnection["method"]; grants?: ConnectionGrant[]; collect?: DataConnection["collect"] },
): Promise<void> {
  const r = await givePart(
    {
      source,
      brand,
      record: {
        id: opts.useId,
        connectorId: opts.connectorId ?? "cloudflare",
        method: opts.method ?? "token_fields",
        label: "Cloudflare",
        account: opts.account,
        ownerUid: "usr_priya",
        grants: opts.grants ?? [
          { to: "members", can: "read" },
          { to: "agent:vizzy", can: "read" },
        ],
        secrets: {},
        health,
        pausedAt: null,
        pausedBy: null,
        status: "connected",
        createdAt: T0,
        updatedAt: T0,
        disconnectedAt: null,
        ...(opts.collect ? { collect: opts.collect } : {}),
      },
      recordActivity: [{ kind: "connected", by: "usr_priya", at: T0, code: "part_given" }],
      by: "usr_priya",
      at: T0,
    },
    { regionDb: world.regionDb },
  );
  if (!r.ok) throw new Error(`seedPart: ${r.why}`);
}
