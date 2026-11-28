import { z } from "zod";

/**
 * A deck for investors or a pack for lenders (`raise_docs`, regional): one document per deck,
 * holding its slides, every kept version with its change note and the context lines its first
 * draft read. Versions live inside the deck's own document, so a save is one transaction on one
 * document. Pure and client safe: zod only.
 */

export const RAISE_DOC_LIMITS = {
  decks: 20,
  versionsKept: 12,
  changes: 200,
  slides: 16,
  minSlides: 3,
  title: 80,
  headline: 160,
  points: 4,
  point: 160,
  notes: 1200,
  blocks: 3,
  needs: 4,
  need: 120,
  compareRows: 4,
  compareCell: 80,
  compareTitle: 40,
  people: 4,
  personName: 60,
  personRole: 60,
  personLine: 120,
  typedName: 60,
  typedFrom: 60,
  quote: 200,
  note: 200,
  series: 12,
  sources: 30,
  sourceText: 220,
  bytes: 700_000,
  maxValue: 1e12,
} as const;

const L = RAISE_DOC_LIMITS;

export const RAISE_DOC_KINDS = ["deck"] as const;
export type RaiseDocKind = (typeof RAISE_DOC_KINDS)[number];

export const DECK_AUDIENCES = ["investor", "lender"] as const;
export type DeckAudience = (typeof DECK_AUDIENCES)[number];

/** loan only with a lender; pre_seed and seed only with an investor. */
export const DECK_STAGES = ["pre_seed", "seed", "loan"] as const;
export type DeckStage = (typeof DECK_STAGES)[number];
export const INVESTOR_STAGES = ["pre_seed", "seed"] as const;

export const SECTION_KEYS = [
  "cover",
  "problem",
  "solution",
  "product",
  "traction",
  "why_now",
  "market",
  "competition",
  "business_model",
  "go_to_market",
  "team",
  "ask",
  "sales",
  "use_of_funds",
  "repayment",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const LAYOUT_KEYS = ["cover", "statement", "three_points", "big_number", "chart", "compare", "team", "ask"] as const;
export type LayoutKey = (typeof LAYOUT_KEYS)[number];

/** The numbers YouGrow fills itself, by meaning (src/lib/metrics/meanings.ts). */
export const SERVER_MEANINGS = ["waitlistSignups", "launchSignups", "signupGrowth"] as const;
export type ServerMeaning = (typeof SERVER_MEANINGS)[number];
export const BLOCK_MEANINGS = [...SERVER_MEANINGS, "typed"] as const;
export type BlockMeaning = (typeof BLOCK_MEANINGS)[number];

export const OUTLINE_IDS = ["investor_pre_seed", "investor_seed", "lender_loan"] as const;
export type OutlineId = (typeof OUTLINE_IDS)[number];

/** Where a context line came from; words.ts says each one in words. */
export const SOURCE_LABELS = ["website", "repo", "brand_map", "brand_strategy", "competitors", "team", "about"] as const;
export type SourceLabel = (typeof SOURCE_LABELS)[number];

export const BLOCK_UNITS = ["count", "money", "percent"] as const;
export const CURRENCIES = ["GBP", "USD", "EUR"] as const;
export const BLOCK_GRAINS = ["total", "week", "month"] as const;
export const WEEK_WINDOWS = [4, 8, 12] as const;

// ----- Ids -------------------------------------------------------------------------------------

export const RAISE_DOC_ID = /^rd_[a-z0-9]{12}$/;
export const SLIDE_ID = /^sl_[a-z0-9]{8}$/;
export const BLOCK_ID = /^mb_[a-z0-9]{8}$/;
export const NEED_ID = /^nd_[a-z0-9]{8}$/;

export const isRaiseDocId = (id: unknown): id is string => typeof id === "string" && RAISE_DOC_ID.test(id);

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** A fresh id: the prefix and `n` lowercase letters and digits (Web Crypto, so client safe). */
export function newId(prefix: "rd" | "sl" | "mb" | "nd", n = prefix === "rd" ? 12 : 8): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

// ----- Schemas ---------------------------------------------------------------------------------

const Text = (max: number) => z.string().max(max);
const Stamp = z.string().max(40);

export const SeriesPointSchema = z.object({
  /** "17 Nov" or "Jan". */
  label: Text(24),
  /** ISO day the week or month starts, when known. */
  start: z.string().max(10).optional(),
  value: z.number().finite(),
});
export type SeriesPoint = z.infer<typeof SeriesPointSchema>;

export const BlockSourceSchema = z.object({
  kind: z.enum(["insights", "audience", "typed"]),
  /** Typed only: where the person said it came from ("your till"). */
  from: Text(L.typedFrom).optional(),
  /** Typed only: the user id that typed it, or "vizzy" for a number the person said in chat. Server stamped. */
  typedBy: Text(128).optional(),
  /** Typed through Vizzy from the person's own words. */
  saidInChat: z.boolean().optional(),
  /** Those words. */
  quote: Text(L.quote).optional(),
});

export const MetricBlockSchema = z.object({
  id: z.string().regex(BLOCK_ID),
  meaning: z.enum(BLOCK_MEANINGS),
  /** week or month with a series: drawn as a chart. */
  grain: z.enum(BLOCK_GRAINS),
  weeks: z.union([z.literal(4), z.literal(8), z.literal(12)]).optional(),
  launchId: Text(64).optional(),
  name: Text(80),
  /** null: no data, shown as a Needs callout, never as 0. */
  value: z.number().finite().nullable(),
  unit: z.enum(BLOCK_UNITS),
  currency: z.enum(CURRENCIES).optional(),
  per: z.enum(["month", "year"]).nullable().optional(),
  /** Oldest first, at most 12. */
  series: z.array(SeriesPointSchema).max(L.series).optional(),
  /** Made by the server, never the model: "4,310", "£14,200 a month". */
  display: Text(80),
  periodWords: Text(80).optional(),
  source: BlockSourceSchema,
  /** When it was filled or typed; frozen in each version. */
  asOf: Stamp,
});
export type MetricBlock = z.infer<typeof MetricBlockSchema>;

export const CompareSchema = z.object({
  leftTitle: Text(L.compareTitle),
  rightTitle: Text(L.compareTitle),
  rows: z.array(z.object({ left: Text(L.compareCell), right: Text(L.compareCell) })).max(L.compareRows),
});
export type SlideCompare = z.infer<typeof CompareSchema>;

export const SlidePersonSchema = z.object({
  name: Text(L.personName),
  role: Text(L.personRole),
  line: Text(L.personLine),
  /** The brand author they were drawn from. */
  authorId: Text(64).optional(),
});
export type SlidePerson = z.infer<typeof SlidePersonSchema>;

export const SlideNeedSchema = z.object({ id: z.string().regex(NEED_ID), text: Text(L.need) });
export type SlideNeed = z.infer<typeof SlideNeedSchema>;

/** Vizzy's last draft of a slide (the AI original): never changed by a person's edit. */
export const SlideAiSchema = z.object({
  headline: Text(L.headline),
  points: z.array(Text(L.point)).max(L.points),
  notes: Text(L.notes),
  at: Stamp,
  /** "raise.deck_draft@1" or "raise.deck_revise@1". */
  prompt: Text(60),
});
export type SlideAi = z.infer<typeof SlideAiSchema>;

export const SlideSchema = z.object({
  id: z.string().regex(SLIDE_ID),
  section: z.enum(SECTION_KEYS),
  layout: z.enum(LAYOUT_KEYS),
  /** May hold tokens {{mb_xxxxxxxx}} and {{mb_xxxxxxxx:period}} (text.ts). */
  headline: Text(L.headline),
  points: z.array(Text(L.point)).max(L.points),
  compare: CompareSchema.optional(),
  people: z.array(SlidePersonSchema).max(L.people).optional(),
  blocks: z.array(MetricBlockSchema).max(L.blocks),
  /** Speaker notes: the talk track. */
  notes: Text(L.notes),
  /** Needs callouts: shown in the editor, never printed or presented. */
  needs: z.array(SlideNeedSchema).max(L.needs),
  /** Pack line ids this slide drew on. */
  sources: z.array(Text(8)).max(L.sources),
  ai: SlideAiSchema.optional(),
});
export type Slide = z.infer<typeof SlideSchema>;

export const PackLineSchema = z.object({
  /** "P1" to "P30", as the prompt names it. */
  id: Text(8),
  text: Text(L.sourceText),
  label: z.enum(SOURCE_LABELS),
  url: Text(600).optional(),
  at: Stamp.optional(),
});
export type PackLine = z.infer<typeof PackLineSchema>;

export const DeckVersionSchema = z.object({
  /** 1, 2, 3... never reused. */
  n: z.number().int().min(1),
  /** The change note, never empty. */
  note: Text(L.note).min(1),
  /** "vizzy" or the person's user id. */
  by: Text(128),
  at: Stamp,
  title: Text(L.title),
  /** Whole, with block values frozen as shown. */
  slides: z.array(SlideSchema).max(L.slides),
});
export type DeckVersion = z.infer<typeof DeckVersionSchema>;

export const DeckChangeSchema = z.object({ n: z.number().int().min(1), note: Text(L.note), by: Text(128), at: Stamp });
export type DeckChange = z.infer<typeof DeckChangeSchema>;

export const RaiseDocSchema = z.object({
  id: z.string().regex(RAISE_DOC_ID),
  tenantId: z.string().min(1),
  kind: z.enum(RAISE_DOC_KINDS),
  audience: z.enum(DECK_AUDIENCES),
  stage: z.enum(DECK_STAGES),
  title: Text(L.title),
  /** S1 has no other state: nothing is sent or shared. */
  status: z.literal("draft"),
  /** The newest version's n. */
  version: z.number().int().min(1),
  /** Equal to the newest version, kept apart so a list or the search sweep can project it. */
  current: z.object({ title: Text(L.title), slides: z.array(SlideSchema).max(L.slides) }),
  /** Version 1 always, plus the newest 11, oldest first. */
  versions: z.array(DeckVersionSchema).max(L.versionsKept),
  /** Every version ever, newest first, at most 200. */
  changes: z.array(DeckChangeSchema).max(L.changes),
  /** The context lines the first draft read, at most 30. */
  sources: z.array(PackLineSchema).max(L.sources),
  outline: z.object({ id: z.enum(OUTLINE_IDS), version: z.literal(1) }),
  made: z.object({ promptId: Text(60), version: z.number().int(), model: Text(80) }).optional(),
  slideCount: z.number().int().min(0),
  words: z.number().int().min(0),
  talkSeconds: z.number().int().min(0),
  createdAt: Stamp,
  createdBy: Text(128),
  updatedAt: Stamp,
  updatedBy: Text(128),
});
export type RaiseDoc = z.infer<typeof RaiseDocSchema>;

/** A stored deck, or null when the record can't be read (fail soft: the list leaves it out). */
export function parseRaiseDoc(raw: unknown): RaiseDoc | null {
  const r = RaiseDocSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** The fields a list reads (a projection: never `versions`). */
export const SUMMARY_FIELDS = ["title", "audience", "stage", "kind", "status", "version", "slideCount", "talkSeconds", "updatedAt", "createdAt", "outline"] as const;

/** A deck in a list. */
export interface RaiseDocSummary {
  id: string;
  title: string;
  audience: DeckAudience;
  stage: DeckStage;
  kindLabel: string;
  status: "draft";
  version: number;
  slideCount: number;
  talkSeconds: number;
  updatedAt: string;
}

/** The stage a deck is for: a lender pack is always a loan, an investor deck pre-seed unless seed. */
export function stageFor(audience: DeckAudience, stage?: DeckStage | null): DeckStage {
  if (audience === "lender") return "loan";
  return stage === "seed" ? "seed" : "pre_seed";
}
