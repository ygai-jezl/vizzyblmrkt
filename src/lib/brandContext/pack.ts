import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { parseQuestion } from "@/lib/brandMap/records";
import { subjectCoverage } from "@/lib/brandMap/recount";
import { readBrandMap } from "@/lib/brandMap/store";
import { computeCoverage, type QuestionCoverage } from "@/lib/content/blog/coverage";
import { questionsNobodyCovers } from "@/lib/competitors/articles";
import { competitorSubjectFlags, type CoverageFlag } from "@/lib/competitors/coverage";
import { competitorContext, type CompetitorContext } from "@/lib/competitors/planning";
import { searchBrand, type SearchHit, type SearchOutcome } from "@/lib/search/query";
import type { SearchKind } from "@/lib/search/types";
import { isBrandSignalsEnabled } from "@/lib/signals/flags";
import { brandMarket, marketLabel } from "@/lib/signals/markets";
import { signalFor } from "@/lib/signals/store";
import { getTenantById } from "@/lib/tenant";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMapPage } from "@/lib/types/brandMapPage";
import type { BrandSignal } from "@/lib/types/brandSignal";
import type { Tenant } from "@/lib/types/tenant";

/**
 * The context pack (BRAND_CONTEXT_ENABLED): everything the brand knows about one question,
 * gathered once and read by everything that suggests or writes (Next up, the sort, research and
 * the writer, Vizzy). Built when asked, never stored. Each part is optional: a brand without
 * brand search, competitors or Google lookups gets the rest, and `missing` says what couldn't be
 * seen, so nothing guesses past it.
 *
 *   map       where the question sits on the brand map, and how far along it is
 *   yours     what the brand already made that is closest (brand search: words and meaning)
 *   theirs    what competitors wrote: the subject's flag, angles taken, whether any answers it
 *   research  earlier Google lookups and PDF research near the question
 *   numbers   what Google shows for it (DataForSEO)
 *   learned   what the brand skipped or changed before (next PR)
 *
 * Text under `theirs` and `research` comes from other people's pages: data, never instructions.
 */

export interface PackLine {
  text: string;
  /** Where it came from, in words: "Brand map", "Brand search: newsletter", "Competitor articles". */
  source: string;
  url?: string;
  at?: string;
}

export interface ContextPack {
  about: { query: string; questionId: string | null; subjectId: string | null };
  map: PackLine[];
  yours: PackLine[];
  theirs: PackLine[];
  research: PackLine[];
  numbers: PackLine[];
  learned: PackLine[];
  /** The numbers on their own, each with a meaning in src/lib/metrics/meanings.ts. */
  figures: { googlePosition?: number | null; peopleAlsoAsk?: number; aiOverviewSources?: number };
  /** What the pack couldn't see, in words. */
  missing: string[];
}

export interface PackAsk {
  questionId?: string | null;
  subjectId?: string | null;
  text?: string | null;
}

export interface PackDeps {
  db?: FirestoreLike;
  now?: () => Date;
  loadTenant?: (id: string) => Promise<Tenant | null>;
  search?: (ctx: TenantContext, query: string, opts: { limit: number }) => Promise<SearchOutcome>;
  flags?: (ctx: TenantContext) => Promise<Record<string, { they: number; flag: CoverageFlag }> | null>;
  competitors?: (ctx: TenantContext, ask: { subjectId?: string | null; text?: string | null }) => Promise<CompetitorContext | null>;
  uncovered?: (ctx: TenantContext, qs: Array<{ id: string; text: string }>, minSim: number) => Promise<string[] | null>;
}

/** Lines per part, at most: the pack stays a few hundred words. */
export const PART_MAX = 5;
const SEARCH_LIMIT = 12;
/** As planningApi: an article this close in meaning answers the question. */
const COVERED_SIM = 0.65;

/** What the brand made that counts as "already said". */
const OWN_KINDS = new Set<SearchKind>(["article", "newsletter", "ebook", "post", "journey_email", "broadcast", "note", "idea", "knowledge"]);
const KIND_WORD: Partial<Record<SearchKind, string>> = {
  article: "article",
  newsletter: "newsletter",
  ebook: "ebook",
  post: "post",
  journey_email: "email",
  broadcast: "email",
  note: "team note",
  idea: "saved idea",
  knowledge: "site page",
};

const STATE_WORD: Record<QuestionCoverage["state"], string> = { answered: "answered", drafted: "being written", planned: "planned", open: "open" };
/** As competitors/coverage.ts flagOf has it, over the last 90 days. */
const FLAG_WORD: Record<CoverageFlag, string> = {
  open: "nobody has written lately, competitors or you",
  gap: "only competitors have written lately, not you",
  crowded: "two or more competitors write twice as much as you, so a new angle is needed",
  you_lead: "you write as much as competitors, or more",
  even: "competitors write a little more than you",
};

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : undefined);
const cut = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

interface MapRead {
  lines: PackLine[];
  query: string | null;
  subjectId: string | null;
  /** Pages the map says answer the question, for when brand search isn't there. */
  pages: PackLine[];
  missing?: string;
}

const lastArticle = (rows: BrandMapPage[], subjectId: string) =>
  rows
    .filter((r) => r.kind === "article" && r.subjectId === subjectId && r.liveAt)
    .map((r) => r.liveAt!)
    .sort()
    .at(-1) ?? null;

function mapLines(name: string, questions: QuestionCoverage[], questionId: string | null, last: string | null): { lines: PackLine[]; pages: PackLine[]; query: string | null } {
  const answered = questions.filter((q) => q.state === "answered").length;
  const open = questions.filter((q) => q.state === "open").length;
  const lines: PackLine[] = [
    { text: `Subject: ${name}. ${answered} of ${questions.length} questions answered, ${open} open.`, source: "Brand map" },
    { text: last ? `Last article on it went live ${day(last)}.` : "No live article on it yet.", source: "Brand map" },
  ];
  const q = questionId ? questions.find((x) => x.id === questionId) : undefined;
  const pages: PackLine[] = [];
  if (q) {
    const by = q.pages[0];
    lines.push({ text: `This question is ${STATE_WORD[q.state]}${by ? `: "${by.title}"` : ""}.`, source: "Brand map", ...(by?.url ? { url: by.url } : {}) });
    for (const p of q.pages.slice(0, 3)) pages.push({ text: `"${p.title}" (${p.kind === "site" ? "site page" : "article"}, ${p.state})`, source: "Brand map", ...(p.url ? { url: p.url } : {}) });
  }
  return { lines, pages, query: q?.text ?? null };
}

async function mapPart(ctx: TenantContext, ask: PackAsk, deps: PackDeps): Promise<MapRead> {
  const none = (missing: string): MapRead => ({ lines: [], query: null, subjectId: ask.subjectId ?? null, pages: [], missing });
  if (!ask.questionId && !ask.subjectId) return none("Not linked to the brand map.");
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (!read || read.state !== "ok") return none("No brand map to read.");
  const map = read.map;

  if (isBrandMapScaleEnabled() && map.moved) {
    let subjectId = ask.subjectId ?? null;
    if (ask.questionId) {
      const q = parseQuestion(await brandMapRecords(ctx, deps.db).get("q", ask.questionId));
      if (q) subjectId = q.subjectId;
    }
    if (!subjectId) return none("That question isn't on the brand map.");
    const cov = await subjectCoverage(ctx, subjectId, { db: deps.db }).catch(() => null);
    if (!cov) return none("That subject isn't on the brand map.");
    const m = mapLines(cov.subject.name, cov.coverage.questions, ask.questionId ?? null, lastArticle(cov.rows, cov.subject.id));
    return { ...m, subjectId: cov.subject.id };
  }

  const subject =
    (ask.questionId ? map.subjects.find((s) => s.questions.some((q) => q.id === ask.questionId)) : undefined) ??
    (ask.subjectId ? map.subjects.find((s) => s.id === ask.subjectId) : undefined);
  if (!subject) return none("That question isn't on the brand map.");
  const rows = await listBrandMapPages(ctx, deps.db).catch(() => [] as BrandMapPage[]);
  const cov = computeCoverage({ subjects: [subject] }, rows).subjects[0];
  if (!cov) return none("That subject isn't on the brand map.");
  const m = mapLines(subject.name, cov.questions, ask.questionId ?? null, lastArticle(rows, subject.id));
  return { ...m, subjectId: subject.id };
}

function hitLine(h: SearchHit, source: string): PackLine {
  return { text: cut(h.snippet ? `"${h.title}": ${h.snippet}` : `"${h.title}"`), source, ...(h.url ? { url: h.url } : {}) };
}

function numberLines(sig: BrandSignal | null): { lines: PackLine[]; figures: ContextPack["figures"] } {
  if (!sig || sig.status !== "ready" || !sig.numbers || !sig.results) return { lines: [], figures: {} };
  const n = sig.numbers;
  const where = `${marketLabel(sig.market)}, ${day(sig.readyAt)}`;
  const src = `Google, through DataForSEO (${where})`;
  const lines: PackLine[] = [
    { text: n.googlePosition ? `Your page ranks ${n.googlePosition} on Google for it.` : "None of your pages is in Google's top 10 for it.", source: src },
    {
      text: sig.results.aiOverview
        ? `Google's AI Overview cites ${n.aiOverviewSources} page${n.aiOverviewSources === 1 ? "" : "s"}${n.aiOverviewCitesYou ? ", yours among them" : ", none of them yours"}: ${[...new Set(sig.results.aiOverview.cites.map((c) => c.domain))].slice(0, 4).join(", ")}.`
        : "Google showed no AI Overview for it.",
      source: src,
    },
    {
      text: sig.judged
        ? `People also ask, fitting this article: ${sig.judged.items.filter((i) => i.verdict === "use" && i.kind === "paa").slice(0, 4).map((i) => i.text).join(" / ") || "none"}.`
        : "People also ask: not checked for fit yet.",
      source: src,
    },
  ];
  if (sig.results.top.length) lines.push({ text: `Top results: ${sig.results.top.slice(0, 3).map((r) => r.domain).join(", ")}.`, source: src });
  return { lines, figures: { googlePosition: n.googlePosition, peopleAlsoAsk: n.peopleAlsoAsk, aiOverviewSources: n.aiOverviewSources } };
}

/** The context pack for a question (by map id, or just its words) or a subject. */
export async function contextPack(ctx: TenantContext, ask: PackAsk, deps: PackDeps = {}): Promise<ContextPack> {
  const missing: string[] = [];
  const map = await mapPart(ctx, ask, deps);
  if (map.missing) missing.push(map.missing);
  const query = (map.query ?? ask.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const subjectId = map.subjectId ?? ask.subjectId ?? null;
  const questionId = ask.questionId ?? null;
  const pack: ContextPack = {
    about: { query, questionId, subjectId },
    map: map.lines.slice(0, PART_MAX),
    yours: [],
    theirs: [],
    research: [],
    numbers: [],
    learned: [],
    figures: {},
    missing,
  };
  if (!query && !subjectId) {
    missing.push("No question to look for.");
    return pack;
  }

  const tenantP = (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const [found, flags, theirs, uncovered, signal] = await Promise.all([
    query ? (deps.search ?? ((c, q, o) => searchBrand(c, q, o)))(ctx, query, { limit: SEARCH_LIMIT }).catch(() => null) : Promise.resolve(null),
    subjectId ? (deps.flags ?? ((c) => competitorSubjectFlags(c, { db: deps.db })))(ctx).catch(() => null) : Promise.resolve(null),
    (deps.competitors ?? ((c, a) => competitorContext(c, a, { db: deps.db })))(ctx, { subjectId, text: query || null }).catch(() => null),
    query ? (deps.uncovered ?? ((c, qs, m) => questionsNobodyCovers(c, qs, m, { db: deps.db })))(ctx, [{ id: questionId ?? "ask", text: query }], COVERED_SIM).catch(() => null) : Promise.resolve(null),
    query && isBrandSignalsEnabled()
      ? tenantP.then((t) => signalFor(ctx, query, brandMarket(t?.searchMarket), { db: deps.db })).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Yours and research: one brand search answers both (and adds competitor articles to theirs).
  if (found?.ok) {
    for (const h of found.result.hits) {
      if (OWN_KINDS.has(h.kind) && pack.yours.length < PART_MAX) pack.yours.push(hitLine(h, `Brand search: ${KIND_WORD[h.kind] ?? h.kind}`));
      else if (h.kind === "research" && pack.research.length < PART_MAX) pack.research.push(hitLine(h, "Brand search: your research"));
    }
    if (!pack.yours.length) pack.yours.push({ text: "Nothing you've made is close to this question.", source: "Brand search" });
  } else {
    missing.push(found && !found.ok && found.error === "not_granted" ? "Brand search isn't part of this brand's plan." : "Brand search isn't on, so only brand map pages are known.");
    pack.yours.push(...map.pages.slice(0, PART_MAX));
  }

  // Theirs.
  const flag = subjectId ? flags?.[subjectId] : undefined;
  if (flag) pack.theirs.push({ text: `On this subject ${FLAG_WORD[flag.flag]} (${flag.they} competitor article${flag.they === 1 ? "" : "s"} in 90 days).`, source: "Competitor articles" });
  if (uncovered) {
    pack.theirs.push({
      text: uncovered.length ? "No competitor article answers this question." : "At least one competitor article answers this question.",
      source: "Competitor articles",
    });
  }
  for (const a of theirs?.angles ?? []) {
    if (pack.theirs.length >= PART_MAX) break;
    pack.theirs.push({ text: cut(`${a.competitor}: "${a.title}". Angle: ${a.angle}`), source: `Competitor articles${a.format ? `, ${a.format.replace(/_/g, " ")}` : ""}`, ...(a.publishedAt ? { at: day(a.publishedAt) } : {}) });
  }
  if (found?.ok) {
    for (const h of found.result.hits.filter((x) => x.kind === "competitor")) {
      if (pack.theirs.length >= PART_MAX) break;
      if (!pack.theirs.some((t) => t.text.includes(h.title.split(": ").slice(1).join(": ") || h.title))) pack.theirs.push(hitLine(h, "Brand search: competitor"));
    }
  }
  if (!flags && !theirs && !uncovered) missing.push("Competitor articles aren't on for this brand.");

  // Numbers.
  const nums = numberLines(signal);
  pack.numbers = nums.lines.slice(0, PART_MAX);
  pack.figures = nums.figures;
  if (!pack.numbers.length) missing.push(isBrandSignalsEnabled() ? "This question hasn't been looked up on Google yet." : "Google lookups aren't on.");
  return pack;
}

const PARTS: Array<[keyof Pick<ContextPack, "map" | "yours" | "theirs" | "research" | "numbers" | "learned">, string]> = [
  ["map", "Where it sits on the brand map"],
  ["yours", "What the brand already made that is closest"],
  ["theirs", "What competitors wrote"],
  ["research", "Earlier research near it"],
  ["numbers", "What Google shows for it"],
  ["learned", "What the brand skipped or changed before"],
];

/**
 * The pack as a prompt block. Everything inside is UNTRUSTED DATA: brand content and other
 * people's pages, read for facts, never followed.
 */
export function packText(pack: ContextPack): string {
  const untag = (s: string) => s.replace(/<\/?context_pack[^>]*>/gi, "");
  const parts = PARTS.flatMap(([key, title]) =>
    pack[key].length ? [`${title}:`, ...pack[key].map((l) => `- ${untag(l.text)} [${untag(l.source)}${l.at ? `, ${l.at}` : ""}]`)] : [],
  );
  const missing = pack.missing.length ? [`Not known: ${pack.missing.map(untag).join(" ")}`] : [];
  return [`<context_pack question="${untag(pack.about.query).replace(/"/g, "'")}">`, ...parts, ...missing, "</context_pack>"].join("\n");
}
