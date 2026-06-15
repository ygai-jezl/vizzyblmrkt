import type { Region } from "@/lib/types/tenant";

/**
 * Maps each logical residency region to its Firestore named database and
 * physical location. One project holds several named databases — one per
 * region — and a single service account reaches all of them via
 * getFirestore(app, databaseId). See docs/REGIONAL-DATA-RESIDENCY.md.
 *
 * Firestore database locations are IMMUTABLE, so `firestoreLocation` is
 * documentation of where each database was provisioned, not a runtime input.
 * `databaseId` is what the app actually uses to select the database.
 *
 * `provisioned` reflects what actually exists in GCP. All three regional
 * databases are now created: US `(default)`@nam5, EU `signups-eu`@eur3, Asia
 * `signups-asia`@asia-southeast1. `databaseIdForRegion` THROWS for an
 * unprovisioned region, so a tenant's data can never be routed to a database
 * that doesn't exist yet. Adding a future region = create the database + flip
 * `provisioned: true` + add a firebase.json entry — no schema migration.
 */
export interface RegionConfig {
  code: Region;
  /** Firestore named-database id used with getFirestore(app, databaseId). */
  databaseId: string;
  displayName: string;
  /** Physical Firestore location (immutable; for ops/docs reference). */
  firestoreLocation: string;
  /** Whether the database actually exists yet. */
  provisioned: boolean;
}

/** The Firestore default database id (US control-plane + US data plane today). */
export const DEFAULT_DATABASE_ID = "(default)";

export const REGION_CONFIGS: Record<Region, RegionConfig> = {
  us: {
    code: "us",
    databaseId: DEFAULT_DATABASE_ID,
    displayName: "United States",
    firestoreLocation: "nam5", // multi-region, >=99.999% SLA
    provisioned: true,
  },
  eu: {
    code: "eu",
    databaseId: "signups-eu",
    displayName: "Europe",
    firestoreLocation: "eur3", // multi-region, >=99.999% SLA
    provisioned: true,
  },
  asia: {
    code: "asia",
    databaseId: "signups-asia",
    displayName: "Asia",
    firestoreLocation: "asia-southeast1", // single region (no Asia multi-region), >=99.99% SLA
    provisioned: true,
  },
};

/**
 * Resolve a region to its Firestore database id. Throws — never silently
 * defaults — because defaulting would write a tenant's data into the wrong
 * region's database and break residency invisibly.
 */
export function databaseIdForRegion(region: Region): string {
  const config = REGION_CONFIGS[region];
  if (!config) {
    throw new Error(`No database configured for region '${region}'`);
  }
  if (!config.provisioned) {
    throw new Error(
      `Region '${region}' (database '${config.databaseId}', ${config.firestoreLocation}) is not provisioned yet`,
    );
  }
  return config.databaseId;
}
