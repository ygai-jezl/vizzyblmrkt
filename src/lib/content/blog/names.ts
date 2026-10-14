import type { BlogEntity, BlogEntityRelation } from "@/lib/types/contentPlan";
import type { BrandMapNameKind } from "@/lib/types/brandMap";
import { fold } from "@/lib/brandMap/changes";
import type { ArticleMap } from "./articleMap";
import { parseArticle, parseInline, type ArticleBlock, type Inline } from "./markdown";

/**
 * Matching an article's names to the brand map's. Pure + client-safe (the live checklist
 * uses it too).
 *
 * Whole names only, never a piece of a word ("Flow" is not "workflow"). An alias applies
 * only when what research says the thing is fits what the map says it is; an alias two
 * names share matches neither. A person's own rows on a brief are never renamed.
 */

const RELATION_OF: Record<BrandMapNameKind, BlogEntityRelation> = {
  product: "product",
  alternative: "alternative",
  integration: "integration",
  audience: "audience",
  use_case: "use_case",
};

interface Entry {
  name: string;
  kind: BrandMapNameKind;
  full: boolean;
}

export interface NameIndex {
  byKey: Map<string, Entry>;
  /** Spellings two names share: they match neither. */
  ambiguous: Set<string>;
  brand: string;
  category: string;
}

export function indexNames(map: Pick<ArticleMap, "identity" | "names">): NameIndex {
  const byKey = new Map<string, Entry>();
  const ambiguous = new Set<string>();
  for (const n of map.names) {
    const k = fold(n.name);
    if (k) byKey.set(k, { name: n.name, kind: n.kind, full: true });
  }
  for (const n of map.names) {
    for (const a of n.aliases) {
      const k = fold(a);
      if (!k) continue;
      const there = byKey.get(k);
      if (there?.full) continue; // a full name always wins
      if (there && there.name !== n.name) {
        ambiguous.add(k);
        byKey.delete(k);
        continue;
      }
      if (!ambiguous.has(k)) byKey.set(k, { name: n.name, kind: n.kind, full: false });
    }
  }
  return { byKey, ambiguous, brand: map.identity.name, category: map.identity.category };
}

const LEGAL = /\s*(?:\((?:[^)]*)\)|,?\s+(?:inc|incorporated|ltd|limited|llc|plc|gmbh|corp|corporation|co)\.?)\s*$/i;

/** The map's entry for a name: its full name, or (failing that) the same name without a legal suffix or a bracket. */
function lookup(index: NameIndex, name: string): Entry | null {
  for (const candidate of [name, name.replace(LEGAL, "")]) {
    const k = fold(candidate);
    if (!k || index.ambiguous.has(k)) continue;
    const hit = index.byKey.get(k);
    if (hit) return hit;
  }
  return null;
}

export interface Canonicalised {
  /** The article's entities, spelled the map's way, brand and category first. */
  entities: BlogEntity[];
  /** Names research found that the map does not have: kept on the article, and suggested for the map. */
  unknown: BlogEntity[];
  /** What was respelled, for the research note. */
  respelled: Array<{ from: string; to: string }>;
}

/**
 * Spell research's names the way the map does. A full name takes the map's kind; an alias
 * only counts when research's kind for it fits the map's. With a map, the brand and its
 * category are the map's (a different wording for either is never kept, and is reported).
 * Idempotent; a person's rows are left exactly as they are.
 */
export function canonicaliseEntities(found: BlogEntity[], index: NameIndex, max: number): Canonicalised {
  const entities: BlogEntity[] = [];
  const unknown: BlogEntity[] = [];
  const respelled: Canonicalised["respelled"] = [];
  const seen = new Set<string>();
  const push = (e: BlogEntity) => {
    const k = fold(e.name);
    if (!k || seen.has(k)) return;
    seen.add(k);
    entities.push(e);
  };
  if (index.brand) push({ name: index.brand, relation: "brand", by: "research" });
  if (index.category) push({ name: index.category, relation: "category", by: "research" });
  for (const e of found) {
    if (e.by === "operator") {
      push(e);
      continue;
    }
    if (e.relation === "brand" && index.brand) {
      if (fold(e.name) !== fold(index.brand)) respelled.push({ from: e.name, to: index.brand });
      continue;
    }
    if (e.relation === "category" && index.category) {
      if (fold(e.name) !== fold(index.category)) respelled.push({ from: e.name, to: index.category });
      continue;
    }
    const hit = lookup(index, e.name);
    if (hit && (hit.full || RELATION_OF[hit.kind] === e.relation)) {
      if (hit.name !== e.name) respelled.push({ from: e.name, to: hit.name });
      push({ name: hit.name, relation: RELATION_OF[hit.kind], by: "research" });
      continue;
    }
    push(e);
    if (e.relation !== "brand" && e.relation !== "category") unknown.push(e);
  }
  return { entities: entities.slice(0, max), unknown, respelled };
}

/** Which of an article's names the map does not have (brand and category aside): the browser marks them. */
export function notOnMap(map: Pick<ArticleMap, "identity" | "names">, entities: BlogEntity[]): (e: BlogEntity) => boolean {
  // Read every row as research's, so a person's own rows are looked up too (never renamed: this only reads).
  const rows = entities.map((e) => ({ ...e, by: "research" as const }));
  const unknown = new Set(canonicaliseEntities(rows, indexNames(map), rows.length + 2).unknown.map((e) => fold(e.name)));
  return (e) => unknown.has(fold(e.name));
}

const LETTER = "\\p{L}\\p{N}";
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Is `name` mentioned in `text` as a whole name? Case matters for a one-word name that is
 * capitalised (so "Notion" is not "notion"), not otherwise. A name in a script written
 * without spaces matches anywhere. No lookbehind: older Safari runs the checklist too.
 */
export function mentionsName(text: string, name: string): boolean {
  const n = name.replace(/\s+/g, " ").trim();
  if (!n || !text) return false;
  if (CJK.test(n)) return text.includes(n);
  const oneWordCapital = !/\s/.test(n) && /^\p{Lu}/u.test(n);
  const pattern = n.split(" ").map(escape).join("\\s+");
  return new RegExp(`(^|[^${LETTER}])${pattern}(?=$|[^${LETTER}])`, oneWordCapital ? "u" : "iu").test(text);
}

/** The words of inline Markdown that the article says itself: no link labels, no code. */
function ownWords(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.t === "text" ? n.v : n.t === "strong" || n.t === "em" ? ownWords(n.c) : " "))
    .join("");
}

/**
 * The article's own sentences: not a heading (a buyer's question keeps a buyer's words), not
 * a quotation, not code, not a link's label, and nothing in the Sources list.
 */
export function ownSentences(markdown: string): string[] {
  const blocks = parseArticle(markdown);
  const texts: string[] = [];
  let inSources = false;
  const take = (text: string) => texts.push(ownWords(parseInline(text)));
  const walk = (list: ArticleBlock[]) => {
    for (const b of list) {
      if (b.kind === "heading") {
        if (b.level <= 2) inSources = /^(sources|references|citations)\b/i.test(b.text.replace(/[*_`]/g, "").trim());
        continue;
      }
      if (inSources || b.kind === "code" || b.kind === "rule") continue;
      if (b.kind === "paragraph") take(b.text);
      else if (b.kind === "list") b.items.forEach(take);
      else if (b.kind === "table") [...b.header, ...b.rows.flat()].forEach(take);
      else if (b.kind === "callout" && b.label) walk(b.blocks);
    }
  };
  walk(blocks);
  return texts
    .join("\n")
    .replace(/([.!?])\s+/g, "$1\n")
    .split(/\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** A term in a sentence, whole, in any case; its plural too ("GEO tool" catches "GEO tools"). */
function containsTerm(sentence: string, term: string): boolean {
  const t = term.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (CJK.test(t)) return sentence.includes(t);
  const pattern = t.split(" ").map(escape).join("\\s+");
  return new RegExp(`(^|[^${LETTER}])${pattern}s?(?=$|[^${LETTER}])`, "iu").test(sentence);
}

/**
 * The names the map avoids that the article uses in its own sentences. A sentence that
 * also gives the name to use ("… what some call GEO tools") does not count.
 */
export function avoidedUses(markdown: string, avoid: Array<{ term: string; useInstead: string }>): Array<{ term: string; useInstead: string; count: number }> {
  if (!avoid.length) return [];
  const sentences = ownSentences(markdown);
  const out: Array<{ term: string; useInstead: string; count: number }> = [];
  for (const a of avoid) {
    const count = sentences.filter((s) => containsTerm(s, a.term) && !(a.useInstead && containsTerm(s, a.useInstead))).length;
    if (count) out.push({ term: a.term, useInstead: a.useInstead, count });
  }
  return out;
}
