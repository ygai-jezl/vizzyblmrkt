/**
 * Worker env + region maps. Deliberately re-implements the small region maps from
 * the main app (src/lib/tenant/region.ts + src/lib/agents/embeddings.ts) because
 * the worker is an ISOLATED container package and cannot import `@/lib/*`. Keep
 * these in sync with the app — the values are residency-critical.
 */

export type Region = "us" | "eu" | "asia";
export type IngestSource = "docs_url" | "website" | "github" | "gitlab";

const REGION_DB: Record<Region, string> = {
  us: "(default)",
  eu: "signups-eu",
  asia: "signups-asia",
};

export function databaseIdForRegion(region: Region): string {
  const id = REGION_DB[region];
  if (!id) throw new Error(`unknown region '${region}'`);
  return id;
}

/** Regional Vertex location for embeddings (no `global` endpoint for text-embedding-005). */
export function embeddingLocation(region: Region): string {
  switch (region) {
    case "us":
      return process.env.EMBEDDINGS_LOCATION_US ?? "us-central1";
    case "eu":
      return process.env.EMBEDDINGS_LOCATION_EU ?? "europe-west4";
    case "asia":
      return process.env.EMBEDDINGS_LOCATION_ASIA ?? "asia-southeast1";
    default:
      throw new Error(`no embedding location for region '${region}'`);
  }
}

export interface JobEnv {
  ticketId: string;
  tenantId: string;
  campaignId: string;
  region: Region;
  source: IngestSource;
  sourceUri: string;
  ref: string | null;
  /** Optional path globs to scope a repo ingest (repos only). */
  includeGlobs: string[] | null;
  project: string;
  /** Max pages a website/docs crawl will fetch. */
  maxPages: number;
}

/** Parse the JSON-encoded INCLUDE_GLOBS env, tolerating absence / malformed input. */
function parseGlobs(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.every((g) => typeof g === "string") && arr.length > 0) {
      return arr;
    }
  } catch {
    /* ignore malformed */
  }
  return null;
}

const REGIONS: Region[] = ["us", "eu", "asia"];
const SOURCES: IngestSource[] = ["docs_url", "website", "github", "gitlab"];

export function readEnv(env: NodeJS.ProcessEnv = process.env): JobEnv {
  const require_ = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing required env ${k}`);
    return v;
  };
  const region = require_("REGION") as Region;
  if (!REGIONS.includes(region)) throw new Error(`invalid REGION '${region}'`);
  const source = require_("INGEST_SOURCE") as IngestSource;
  if (!SOURCES.includes(source)) throw new Error(`invalid INGEST_SOURCE '${source}'`);
  const maxPages = Number(env.KNOWLEDGE_MAX_PAGES);
  return {
    ticketId: require_("TICKET_ID"),
    tenantId: require_("TENANT_ID"),
    campaignId: require_("CAMPAIGN_ID"),
    region,
    source,
    sourceUri: require_("SOURCE_URI"),
    ref: env.INGEST_REF || null,
    includeGlobs: parseGlobs(env.INCLUDE_GLOBS),
    project: require_("GOOGLE_CLOUD_PROJECT"),
    maxPages: Number.isFinite(maxPages) && maxPages > 0 ? Math.min(maxPages, 100) : 20,
  };
}
