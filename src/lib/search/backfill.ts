import { tenantMayUse } from "@/lib/plans/brandAccess";
import type { Tenant } from "@/lib/types/tenant";
import type { SweepCounts } from "./sweep";
import { readSearchKind, type SearchKind } from "./types";

/**
 * What scripts/search-backfill.ts decides before it reads anything: which brands, which kinds, and
 * what a dry run says --apply would cost. Pure, so it is tested without a database.
 */

/** gemini-embedding-001 on Vertex AI, US dollars per million input tokens. */
export const EMBED_DOLLARS_PER_MILLION_TOKENS = 0.15;
/** About this many characters to a token, for an estimate. */
export const CHARS_PER_TOKEN = 4;

/** The kinds `--kinds` names (aliases read as today's kind), or the first name that isn't one. */
export function parseKinds(names: string[]): { kinds: Set<SearchKind> } | { unknown: string } {
  const kinds = new Set<SearchKind>();
  for (const name of names) {
    const kind = readSearchKind(name.trim());
    if (!kind) return { unknown: name };
    kinds.add(kind);
  }
  return { kinds };
}

/**
 * The brands to fill. Without --all-brands, those granted brand_search, as before. With it, every
 * brand: those without brand_search get the brand map family only (SEARCH_FAMILY_INDEX_ENABLED).
 */
export function backfillTargets(tenants: Tenant[], opts: { allBrands: boolean; tenant?: string }): Array<{ tenant: Tenant; familyOnly: boolean }> {
  return tenants.flatMap((t) => {
    if (opts.tenant && t.id !== opts.tenant) return [];
    const granted = tenantMayUse(t, "brand_search");
    if (!granted && !opts.allBrands) return [];
    return [{ tenant: t, familyOnly: !granted }];
  });
}

/** "120 chunks, about 30,000 tokens, about $0.0045" for what a dry run says --apply would embed. */
export function costWords(est: NonNullable<SweepCounts["estimate"]>): string {
  const tokens = Math.ceil(est.chars / CHARS_PER_TOKEN);
  const dollars = (tokens / 1_000_000) * EMBED_DOLLARS_PER_MILLION_TOKENS;
  const money = dollars === 0 ? "$0" : dollars < 0.0001 ? "under $0.0001" : `about $${dollars.toFixed(4)}`;
  const n = (x: number, one: string, many: string) => `${x.toLocaleString("en-US")} ${x === 1 ? one : many}`;
  return `${n(est.chunks, "chunk", "chunks")}, about ${n(tokens, "token", "tokens")}, ${money}; ${n(est.statusOnly, "record", "records")} status only`;
}
