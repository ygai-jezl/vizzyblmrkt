import type { NearestRun } from "@/lib/tenant/searchIndex";
import type { NearestHit, SearchChunkDoc, SearchKind, SearchManifest, SearchStatus, SearchStore, StoredSearchManifest } from "./types";

/**
 * scripts/search-nearest-check.ts: the filter-first check for the brand map family (ADR-0023). Does
 * nearest find the subjects closest to an article's vector when thousands of other chunks are
 * there, does people's search find a decided subject among thousands of proposals, and what does
 * each read cost (Query Explain). Pure parts here, tested on the in-memory index.
 */

/** How many made-up chunks of each kind the seed adds. */
export const SEED_CHUNKS = 5_000;
/** The made-up records the seed adds, under a throwaway brand path. */
export const SEED_REFS = { subject: "qcheck_subject", articles: "qcheck_articles", proposals: "qcheck_proposals" } as const;

/** A random point on the unit sphere (rand gives numbers in [0, 1)). */
export function randomUnitVector(dim: number, rand: () => number): number[] {
  const v = Array.from({ length: dim }, () => {
    // Box Muller: a normal draw per number makes the direction uniform.
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  });
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** A vector a little way from `v`, still unit length: an article written on that subject. */
export function near(v: number[], rand: () => number, noise = 0.15): number[] {
  const r = randomUnitVector(v.length, rand);
  const w = v.map((x, i) => x + noise * r[i]!);
  const n = Math.hypot(...w);
  return w.map((x) => x / n);
}

/** A throwaway brand id beside the brand's own, so the seed never touches the brand's index. */
export function throwawayTenantId(tenantId: string, rand: () => number): string {
  return `${tenantId.slice(0, 80)}_qcheck_${Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0")}`;
}

/**
 * Seed a throwaway brand's index: one decided subject, SEED_CHUNKS article chunks and SEED_CHUNKS
 * proposed subject chunks with random vectors. Returns the decided subject's vector.
 */
export async function seedCheck(store: SearchStore, tenantId: string, opts: { dim: number; count?: number; rand: () => number; now: string }): Promise<number[]> {
  const count = opts.count ?? SEED_CHUNKS;
  const subject = randomUnitVector(opts.dim, opts.rand);
  const put = async (kind: SearchKind, ref: string, vectors: number[][], status?: SearchStatus) => {
    const sourceKey = `${kind}:${ref}`;
    const chunks: SearchChunkDoc[] = vectors.map((embedding, chunk) => ({
      tenantId,
      kind,
      ref,
      sourceKey,
      chunk,
      title: `Made-up ${kind} ${chunk}`,
      text: `Made-up text for the nearest check, ${kind} ${chunk}.`,
      url: "",
      lang: "en",
      updatedAt: opts.now,
      ...(status ? { status } : {}),
      embedding,
      embeddingModel: "nearest-check",
    }));
    const manifest: StoredSearchManifest = { sourceKey, kind, ref, hash: "nearest-check", chunks: chunks.length, embedded: true, indexedAt: opts.now, ...(status ? { status } : {}) };
    await store.putSource(manifest, chunks, 0);
  };
  await put("subject", SEED_REFS.subject, [subject], "decided");
  await put("article", SEED_REFS.articles, Array.from({ length: count }, () => randomUnitVector(opts.dim, opts.rand)));
  await put("subject", SEED_REFS.proposals, Array.from({ length: count }, () => randomUnitVector(opts.dim, opts.rand)), "proposed");
  return subject;
}

export interface CheckResult {
  /** The decided subject came first for an article's vector, among the made-up chunks. */
  nearestFound: boolean;
  /** People's search found the decided subject, and no proposal. */
  peopleFound: boolean;
  explain: string | null;
  lines: string[];
}

/** What a hit list says, one line. */
export const hitWords = (hits: NearestHit[]): string => (hits.length ? hits.map((h) => `${h.kind} ${h.ref} (${h.status}) ${h.score.toFixed(3)}`).join("; ") : "nothing");

type Nearest = (kinds: SearchKind[], vector: number[], opts: { statuses: SearchStatus[]; limit: number }) => Promise<NearestRun>;

/** Run the two checks on a seeded index. `nearest` is explainNearest on a real database, or the store's own. */
export async function checkSeeded(store: SearchStore, nearest: Nearest, subject: number[], rand: () => number): Promise<CheckResult> {
  const article = near(subject, rand);
  const run = await nearest(["subject"], article, { statuses: ["decided"], limit: 5 });
  const people = await store.meaning(subject, { limit: 10 });
  const nearestFound = run.hits[0]?.ref === SEED_REFS.subject;
  const peopleFound = people.some((c) => c.ref === SEED_REFS.subject) && !people.some((c) => c.ref === SEED_REFS.proposals);
  return {
    nearestFound,
    peopleFound,
    explain: run.explain,
    lines: [
      `nearest subjects to an article's vector: ${hitWords(run.hits)}`,
      `${nearestFound ? "OK" : "FAILED"}: the decided subject ${nearestFound ? "came first" : "was not first"} among ${(SEED_CHUNKS * 2).toLocaleString("en-US")} other chunks`,
      `people's search for the subject's meaning: ${people.length} results, ${peopleFound ? "OK: the decided subject and no proposal" : "FAILED: the decided subject is missing, or a proposal showed"}`,
    ],
  };
}

/** A brand's index by kind, from its manifests: records and chunks. */
export function indexByKind(manifests: SearchManifest[]): string {
  const by = new Map<string, { records: number; chunks: number }>();
  for (const m of manifests) {
    const k = `${m.kind}${m.status ? ` ${m.status}` : ""}`;
    const row = by.get(k) ?? { records: 0, chunks: 0 };
    row.records += 1;
    row.chunks += m.chunks;
    by.set(k, row);
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, r]) => `${k}: ${r.records} records, ${r.chunks} chunks`)
    .join("; ") || "empty";
}

/** A seeded random source (mulberry32), so a check can be run again the same way. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
