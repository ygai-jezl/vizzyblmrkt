/**
 * Worker env + region/owner maps. Deliberately re-implements the small maps from
 * the main app (src/lib/tenant/region.ts, src/lib/tenant/knowledge.ts,
 * src/lib/agents/embeddings.ts) because the worker is an ISOLATED container
 * package and cannot import `@/lib/*`. Keep these in sync with the app — the
 * values are residency- and ownership-critical.
 */

export type Region = "us" | "eu" | "asia";
export type IngestSource = "docs_url" | "website" | "github" | "gitlab";
export type OwnerKind = "campaign" | "workspace";

const REGION_DB: Record<Region, string> = {
  us: "(default)",
  eu: "signups-eu",
  asia: "signups-asia",
};

const OWNER_COLLECTION: Record<OwnerKind, string> = {
  campaign: "campaigns",
  workspace: "workspaces",
};

export function databaseIdForRegion(region: Region): string {
  const id = REGION_DB[region];
  if (!id) throw new Error(`unknown region '${region}'`);
  return id;
}

export function ownerCollection(kind: OwnerKind): string {
  const c = OWNER_COLLECTION[kind];
  if (!c) throw new Error(`unknown ownerKind '${kind}'`);
  return c;
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
  ownerKind: OwnerKind;
  ownerId: string;
  region: Region;
  source: IngestSource;
  sourceUri: string;
  ref: string | null;
  includeGlobs: string[] | null;
  topic: string;
  tags: string[];
  project: string;
  maxPages: number;
}

function parseStringArray(raw: string | undefined): string[] | null {
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
const OWNER_KINDS: OwnerKind[] = ["campaign", "workspace"];

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
  const ownerKind = require_("OWNER_KIND") as OwnerKind;
  if (!OWNER_KINDS.includes(ownerKind)) throw new Error(`invalid OWNER_KIND '${ownerKind}'`);
  const maxPages = Number(env.KNOWLEDGE_MAX_PAGES);
  return {
    ticketId: require_("TICKET_ID"),
    tenantId: require_("TENANT_ID"),
    ownerKind,
    ownerId: require_("OWNER_ID"),
    region,
    source,
    sourceUri: require_("SOURCE_URI"),
    ref: env.INGEST_REF || null,
    includeGlobs: parseStringArray(env.INCLUDE_GLOBS),
    topic: require_("TOPIC"),
    tags: parseStringArray(env.TAGS) ?? [],
    project: require_("GOOGLE_CLOUD_PROJECT"),
    maxPages: Number.isFinite(maxPages) && maxPages > 0 ? Math.min(maxPages, 100) : 20,
  };
}
