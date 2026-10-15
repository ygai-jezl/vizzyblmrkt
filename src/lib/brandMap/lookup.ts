import { z } from "zod";
import { readTextCapped, safeFetch } from "@/lib/security/ssrf";
import { platformOrigin } from "@/lib/platform/origin";
import { siteOf } from "@/lib/knowledge/site";
import { fold } from "./changes";

/**
 * Identifier lookups for the brand map's `sameAs` (BRAND_MAP_WIKIDATA_ENABLED): candidates
 * for one name from Wikidata's public API. Only the name is sent. Nothing is stored here: a
 * person reads each candidate's description, presses "Use this", and saves the map.
 *
 *  1. wbsearchentities — up to five items whose label or alias is like the name;
 *  2. wbgetentities    — their labels and aliases (English and the shared `mul` labels
 *                        Wikidata now keeps many names under) and English Wikipedia page;
 *  3. wbgetclaims      — the official website (P856) of the top three.
 *
 * Code marks a candidate as matching only when the name equals one of its labels or
 * aliases, and as "this looks like you" only for the brand itself, when its official
 * website is one of the brand's own domains. Nothing is ever pre-confirmed.
 */

const API = "https://www.wikidata.org/w/api.php";
const TIMEOUT_MS = 4_000;
const MAX_BYTES = 200_000;
const QID = /^Q[1-9]\d*$/;

export type LookupKind = "brand" | "category" | "product" | "alternative" | "integration";

export interface LookupCandidate {
  id: string;
  label: string;
  description: string;
  /** The Wikidata item's page. */
  wikidataUrl: string;
  /** Its English Wikipedia page, when it has one. */
  wikipediaUrl: string | null;
  /** Its official websites (P856), for the top three. */
  officialSites: string[];
  /** The name equals one of its labels or aliases. */
  matched: boolean;
  /** For the brand itself: its official website is one of the brand's own domains. */
  looksLikeYou: boolean;
}

const SearchSchema = z.object({
  search: z
    .array(z.object({ id: z.string(), label: z.string().optional(), description: z.string().optional() }))
    .default([]),
});
const Labels = z.record(z.string(), z.object({ value: z.string() })).default({});
const EntitiesSchema = z.object({
  entities: z
    .record(
      z.string(),
      z.object({
        labels: Labels,
        descriptions: Labels,
        aliases: z.record(z.string(), z.array(z.object({ value: z.string() }))).default({}),
        sitelinks: z.record(z.string(), z.object({ url: z.string().optional() })).default({}),
      }),
    )
    .default({}),
});
const ClaimsSchema = z.object({
  claims: z
    .object({
      P856: z
        .array(z.object({ rank: z.string().optional(), mainsnak: z.object({ datavalue: z.object({ value: z.unknown() }).optional() }) }))
        .default([]),
    })
    .partial()
    .default({}),
});

export type FetchJson = (url: string) => Promise<unknown | null>;

/** A neutral client name, with this instance's own address to reach it by (Wikimedia's User-Agent policy). */
function userAgent(): string {
  const origin = platformOrigin();
  return `Vizzybl-BrandMap/1.0${origin ? ` (${origin})` : ""}`;
}

async function fetchJsonDefault(url: string): Promise<unknown | null> {
  try {
    const res = await safeFetch(url, { headers: { "User-Agent": userAgent(), Accept: "application/json" } }, { timeoutMs: TIMEOUT_MS, maxRedirects: 1 });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    // A capped read can cut the answer short; a cut answer does not parse, and is no answer.
    return JSON.parse(await readTextCapped(res, MAX_BYTES));
  } catch {
    return null;
  }
}

const query = (params: Record<string, string>) => `${API}?${new URLSearchParams({ format: "json", ...params }).toString()}`;

export async function lookupName(
  name: string,
  opts: { kind: LookupKind; ownSites?: (string | null | undefined)[] },
  deps: { fetchJson?: FetchJson } = {},
): Promise<{ ok: true; candidates: LookupCandidate[] } | { ok: false; error: string }> {
  const term = name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!term) return { ok: false, error: "invalid_input" };
  const fetchJson = deps.fetchJson ?? fetchJsonDefault;

  const found = SearchSchema.safeParse(
    await fetchJson(query({ action: "wbsearchentities", search: term, language: "en", uselang: "en", type: "item", limit: "5" })),
  );
  if (!found.success) return { ok: false, error: "lookup_unavailable" };
  const ids = found.data.search.map((s) => s.id).filter((id) => QID.test(id));
  if (!ids.length) return { ok: true, candidates: [] };

  const details = EntitiesSchema.safeParse(
    await fetchJson(
      query({
        action: "wbgetentities",
        ids: ids.join("|"),
        props: "labels|aliases|descriptions|sitelinks/urls",
        languages: "en|mul",
        sitefilter: "enwiki",
      }),
    ),
  );
  if (!details.success) return { ok: false, error: "lookup_unavailable" };

  const want = fold(term);
  const candidates: LookupCandidate[] = [];
  for (const id of ids) {
    const e = details.data.entities[id];
    if (!e) continue;
    const label = e.labels.en?.value ?? e.labels.mul?.value ?? found.data.search.find((s) => s.id === id)?.label ?? id;
    const description = e.descriptions.en?.value ?? e.descriptions.mul?.value ?? "";
    if (/^wikimedia disambiguation page$/i.test(description)) continue;
    const names = [label, ...(e.aliases.en ?? []).map((a) => a.value), ...(e.aliases.mul ?? []).map((a) => a.value)];
    const wiki = e.sitelinks.enwiki?.url ?? "";
    candidates.push({
      id,
      label,
      description,
      wikidataUrl: `https://www.wikidata.org/wiki/${id}`,
      wikipediaUrl: /^https:\/\/en\.wikipedia\.org\/wiki\/\S+$/.test(wiki) ? wiki : null,
      officialSites: [],
      matched: names.some((n) => fold(n) === want),
      looksLikeYou: false,
    });
  }

  // The official website of the top three: shown, and for the brand itself compared with its own domains.
  const own = new Set((opts.ownSites ?? []).map((s) => (s ? siteOf(s) : "")).filter(Boolean));
  await Promise.all(
    candidates.slice(0, 3).map(async (c) => {
      const claims = ClaimsSchema.safeParse(await fetchJson(query({ action: "wbgetclaims", entity: c.id, property: "P856" })));
      if (!claims.success) return;
      c.officialSites = (claims.data.claims.P856 ?? [])
        .filter((claim) => claim.rank !== "deprecated")
        .map((claim) => claim.mainsnak.datavalue?.value)
        .filter((v): v is string => typeof v === "string" && /^https?:\/\//i.test(v))
        .slice(0, 3);
      c.looksLikeYou = opts.kind === "brand" && c.officialSites.some((u) => own.has(siteOf(u)));
    }),
  );
  return { ok: true, candidates };
}
