import { DEFAULT_LAYOUT } from "./outlines";
import { formatValue, keepTokens, segmentsOf, textOf, type Segment } from "./text";
import { RAISE_DOC_LIMITS as L, newId, type DeckAudience, type MetricBlock, type SectionKey, type ServerMeaning, type Slide } from "./types";
import { BLOCK_NAME, OUTLINE_NEED, SECTION_LABEL } from "./words";

/**
 * Changing a deck in the studio, before it is saved: pure helpers over the slides the person is
 * editing, and the save body the admin API reads (PUT /api/admin/raise/docs/[docId]). A number the
 * person inserts is a block with no date yet: YouGrow's own numbers are filled by the server when
 * the slide is saved, and a typed number is stamped then with who typed it and when. Client safe.
 */

/** A block inserted here and not saved yet: the server fills or stamps it on save. */
export const isPending = (b: Pick<MetricBlock, "asOf">) => b.asOf === "";

/** Where an inserted number's token goes: the headline, a point or the notes. */
export type TextField = { kind: "headline" } | { kind: "point"; i: number } | { kind: "notes" };

/** One of YouGrow's own numbers, asked for here and filled by the server on save. */
export function pendingServerBlock(req: { meaning: ServerMeaning; grain: "total" | "week"; weeks?: 4 | 8 | 12; launchId?: string; launchName?: string }): MetricBlock {
  const name =
    req.meaning === "launchSignups"
      ? BLOCK_NAME.launchSignups(req.launchName ?? "a launch").slice(0, 80)
      : req.meaning === "signupGrowth"
        ? BLOCK_NAME.signupGrowth
        : req.grain === "week"
          ? BLOCK_NAME.waitlistWeekly
          : BLOCK_NAME.waitlistSignups;
  return {
    id: newId("mb"),
    meaning: req.meaning,
    grain: req.meaning === "waitlistSignups" ? req.grain : "total",
    ...(req.meaning === "launchSignups" ? { launchId: req.launchId } : { weeks: req.weeks ?? 12 }),
    name,
    value: null,
    unit: req.meaning === "signupGrowth" ? "percent" : "count",
    display: "",
    source: { kind: req.meaning === "launchSignups" ? "audience" : "insights" },
    asOf: "",
  };
}

export interface TypedNumber {
  name: string;
  value: number;
  unit: MetricBlock["unit"];
  currency?: MetricBlock["currency"];
  per?: "month" | "year" | null;
  from?: string;
  /** Several, one per week or month: drawn as a chart. */
  series?: Array<{ label: string; value: number }>;
}

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** A number the person typed, shown at once and stamped by the server on save. */
export function typedLocalBlock(t: TypedNumber): MetricBlock {
  const currency = t.unit === "money" ? (t.currency ?? "GBP") : undefined;
  const per = t.per ?? null;
  const series = (t.series ?? []).slice(0, L.series).map((p) => ({ label: clip(p.label, 24), value: p.value }));
  const from = clip(t.from, L.typedFrom);
  return {
    id: newId("mb"),
    meaning: "typed",
    grain: series.length ? "month" : "total",
    name: clip(t.name, L.typedName) || "Number",
    value: t.value,
    unit: t.unit,
    ...(currency ? { currency } : {}),
    per,
    ...(series.length ? { series } : {}),
    display: formatValue({ value: t.value, unit: t.unit, currency, per }),
    source: { kind: "typed", ...(from ? { from } : {}) },
    asOf: "",
  };
}

const token = (id: string) => `{{${id}}}`;
const appendToken = (text: string, id: string) => `${text.replace(/\s+$/, "")}${text.trim() ? " " : ""}${token(id)}`;

/** Layouts that show a slide's numbers as big figures or a chart, so a new number needs no token. */
const SHOWS_BLOCKS = new Set<Slide["layout"]>(["big_number", "chart", "ask"]);

function withBlock(slide: Slide, block: MetricBlock, field?: TextField): Slide {
  const next: Slide = { ...slide, blocks: [...slide.blocks, block] };
  const target: TextField | null = field ?? (SHOWS_BLOCKS.has(slide.layout) ? null : { kind: "headline" });
  if (!target) return next;
  if (target.kind === "headline") return { ...next, headline: appendToken(slide.headline, block.id) };
  if (target.kind === "notes") return { ...next, notes: appendToken(slide.notes, block.id) };
  const points = [...slide.points];
  if (target.i >= points.length) points.push(token(block.id));
  else points[target.i] = appendToken(points[target.i] ?? "", block.id);
  return { ...next, points };
}

/** Whether every field the token can go in still fits the length the save accepts. */
const fits = (s: Slide) => s.headline.length <= L.headline && s.notes.length <= L.notes && s.points.length <= L.points && s.points.every((p) => p.length <= L.point);

/**
 * Why a number can't go in: the slide already holds 3 ("full"), or its token would make the field
 * longer than the save accepts ("no_room"). Null when it can.
 */
export function insertRefusal(slide: Slide, block: MetricBlock, field?: TextField): "full" | "no_room" | null {
  if (slide.blocks.length >= L.blocks) return "full";
  return fits(withBlock(slide, block, field)) ? null : "no_room";
}

/**
 * The slide with a number added. On a layout that shows numbers itself it is only added; elsewhere
 * its token also goes at the end of the field the person was in (the headline by default), so the
 * figure always reads from its block. Null when the slide already holds 3, or when the token would
 * make the field too long to save (insertRefusal says which).
 */
export function insertBlock(slide: Slide, block: MetricBlock, field?: TextField): Slide | null {
  return insertRefusal(slide, block, field) ? null : withBlock(slide, block, field);
}

/** The slide without a number, and without every token that showed it. */
export function removeBlock(slide: Slide, blockId: string): Slide {
  const blocks = slide.blocks.filter((b) => b.id !== blockId);
  const ids = new Set(blocks.map((b) => b.id));
  const t = (s: string) => keepTokens(s, ids).trim();
  return {
    ...slide,
    blocks,
    headline: t(slide.headline),
    points: slide.points.map(t),
    notes: t(slide.notes),
    ...(slide.compare ? { compare: { ...slide.compare, rows: slide.compare.rows.map((r) => ({ left: t(r.left), right: t(r.right) })) } } : {}),
  };
}

export const dismissNeed = (slide: Slide, needId: string): Slide => ({ ...slide, needs: slide.needs.filter((n) => n.id !== needId) });

/** A new slide for a section, after the slide at `after` (-1 puts it first). Null at 16 slides. */
export function addSlide(slides: readonly Slide[], after: number, section: SectionKey): { slides: Slide[]; index: number } | null {
  if (slides.length >= L.slides) return null;
  const slide: Slide = {
    id: newId("sl"),
    section,
    layout: DEFAULT_LAYOUT[section],
    headline: SECTION_LABEL[section],
    points: [],
    blocks: [],
    notes: "",
    needs: [{ id: newId("nd"), text: OUTLINE_NEED }],
    sources: [],
  };
  const at = Math.max(0, Math.min(slides.length, after + 1));
  return { slides: [...slides.slice(0, at), slide, ...slides.slice(at)], index: at };
}

/** The slides with one moved up (-1) or down (1). Unchanged at either end. */
export function moveSlide(slides: readonly Slide[], i: number, by: -1 | 1): Slide[] {
  const j = i + by;
  if (i < 0 || i >= slides.length || j < 0 || j >= slides.length) return [...slides];
  const out = [...slides];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** The slides without one. Null when the deck would have fewer than 3. */
export function removeSlide(slides: readonly Slide[], i: number): Slide[] | null {
  if (slides.length <= L.minSlides || i < 0 || i >= slides.length) return null;
  return slides.filter((_, k) => k !== i);
}

/**
 * A text's segments for editing: always text, then a number, then text, so there is a place to type
 * before, between and after every number.
 */
export function editSegments(text: string): Segment[] {
  const out: Segment[] = [];
  for (const s of segmentsOf(text)) {
    if (s.kind === "block" && out.at(-1)?.kind !== "text") out.push({ kind: "text", text: "" });
    out.push(s);
  }
  if (out.at(-1)?.kind !== "text") out.push({ kind: "text", text: "" });
  return out;
}

/** The text with one of its editing segments changed. */
export function withSegmentText(text: string, at: number, value: string): string {
  const segs = editSegments(text);
  const s = segs[at];
  if (!s || s.kind !== "text") return text;
  segs[at] = { kind: "text", text: value };
  return textOf(segs);
}

// ----- The save body ----------------------------------------------------------------------------

type ServerBlockBody = { id: string; meaning: ServerMeaning; grain: "total" | "week"; weeks?: 4 | 8 | 12; launchId?: string };
type TypedBlockBody = {
  id: string;
  meaning: "typed";
  grain?: "total" | "week" | "month";
  name: string;
  value: number;
  unit: MetricBlock["unit"];
  currency?: MetricBlock["currency"];
  per?: "month" | "year" | null;
  series?: Array<{ label: string; value: number }>;
  from?: string;
};
export type BlockBody = ServerBlockBody | TypedBlockBody;

/** A block as the save reads it: YouGrow's numbers by what they ask for, a typed one with its figure. Null for a typed block with no figure. */
export function blockBody(b: MetricBlock): BlockBody | null {
  if (b.meaning !== "typed") {
    return {
      id: b.id,
      meaning: b.meaning,
      grain: b.grain === "week" ? "week" : "total",
      ...(b.weeks !== undefined ? { weeks: b.weeks } : {}),
      ...(b.launchId ? { launchId: b.launchId } : {}),
    };
  }
  if (b.value === null) return null;
  return {
    id: b.id,
    meaning: "typed",
    grain: b.grain,
    name: b.name.slice(0, L.typedName),
    value: b.value,
    unit: b.unit,
    ...(b.currency ? { currency: b.currency } : {}),
    per: b.per ?? null,
    ...(b.series?.length ? { series: b.series.map((p) => ({ label: p.label, value: p.value })) } : {}),
    ...(b.source.from ? { from: b.source.from } : {}),
  };
}

export interface SaveBody {
  baseVersion: number;
  title: string;
  slides: Array<Omit<Slide, "blocks" | "ai"> & { blocks: BlockBody[] }>;
  note?: string;
}

/** What Save changes sends: the slides without Vizzy's originals (the server keeps those). */
export function saveBody(baseVersion: number, title: string, slides: readonly Slide[], note?: string): SaveBody {
  return {
    baseVersion,
    title: title.trim().slice(0, L.title) || "Deck",
    slides: slides.map(({ ai: _ai, ...s }) => ({ ...s, blocks: s.blocks.map(blockBody).filter((b): b is BlockBody => b !== null) })),
    ...(note?.trim() ? { note: note.trim().slice(0, L.note) } : {}),
  };
}

/** Whether the deck in the studio differs from the one saved. */
export function isChanged(saved: { title: string; slides: readonly Slide[] }, now: { title: string; slides: readonly Slide[] }): boolean {
  return saved.title !== now.title || JSON.stringify(saved.slides) !== JSON.stringify(now.slides);
}

/** How many slides still have Needs: they don't print. */
export const needsCount = (slides: readonly Slide[]) => slides.filter((s) => s.needs.length > 0).length;

/** Whether the deck is for investors: only then does Save as PDF show the UK reminder first. */
export const showsUkReminder = (audience: DeckAudience) => audience === "investor";
