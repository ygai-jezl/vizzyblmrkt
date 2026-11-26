import { z } from "zod";
import { generateJsonWithSchema, parseFirstJson } from "@/lib/agents/gemini";
import { TEXT_MODEL } from "@/lib/agents/modelConfig";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { aiUsage } from "@/lib/plans/meter";
import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { pointsCap } from "./layouts";
import { fillBlock, metricReader, type BlockRequest, type MetricDeps, type MetricReader } from "./metrics";
import { AMOUNT_NEED, DEFAULT_LAYOUT, MISSING_SECTION, SECTION_BRIEF, guidanceFor, kindLabel, outlineFor, outlineIdFor, type Outline } from "./outlines";
import { raiseContext, type RaisePack, type RaisePackDeps } from "./pack";
import { createRaiseDoc, type RaiseResult, type StoreDeps } from "./store";
import {
  LAYOUT_KEYS,
  RAISE_DOC_LIMITS as L,
  SECTION_KEYS,
  SERVER_MEANINGS,
  newId,
  stageFor,
  type DeckAudience,
  type DeckStage,
  type LayoutKey,
  type MetricBlock,
  type RaiseDoc,
  type SectionKey,
  type Slide,
  type SlideNeed,
} from "./types";
import { MISSING_WORDS, NOTE_WORDS, OUTLINE_NEED, SECTION_LABEL, SOURCE_LABEL_WORDS } from "./words";

/**
 * Drafting a deck: the context pack, one call to the default text model (prompt raise.deck_draft,
 * counted under raise_write) with structured output, then code checks the answer. The model never
 * writes a figure: it asks for number blocks by meaning, and the server fills each one with its
 * source and date. Team people come only from the brand's own author list. Without a model, or on
 * any failure, the same outline is saved with Needs and the server's numbers, and no model words.
 * Saved as version 1, a draft: nothing is sent or shared.
 */

export const DRAFT_PROMPT = { id: "raise.deck_draft", version: 1 } as const;
export const DRAFT_PROMPT_TAG = `${DRAFT_PROMPT.id}@${DRAFT_PROMPT.version}`;
export const DRAFT_TIMEOUT_MS = 75_000;
const THINKING = 512;

export interface DraftInput {
  audience: DeckAudience;
  stage?: DeckStage | null;
  title?: string | null;
  /** The person's own words: untrusted, fenced in the prompt. */
  brief?: string | null;
  /** "vizzy" or the person's user id: who asked for the draft. */
  by: string;
}

export interface DraftDeps extends StoreDeps {
  pack?: Omit<RaisePackDeps, "reader">;
  metrics?: MetricDeps;
  generate?: typeof generateJsonWithSchema;
  loadTenant?: (id: string) => Promise<Tenant | null>;
}

export interface Drafted {
  doc: RaiseDoc;
  /** False when the outline was saved without the model's words. */
  drafted: boolean;
  warnings: string[];
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

// ----- The prompt ------------------------------------------------------------------------------

function audienceWords(audience: DeckAudience, stage: DeckStage): string {
  if (audience === "lender") {
    return "a bank or other lender, for a business loan. A loan is not an investment: use no equity words such as shares, valuation, round, equity or investors.";
  }
  return `investors, for a ${stage === "seed" ? "seed" : "pre-seed"} round.`;
}

function outlineText(outline: Outline): string {
  return outline.sections
    .map((s, i) => `${i + 1}. ${s} (layout ${DEFAULT_LAYOUT[s]}): ${SECTION_BRIEF[s]}. ${guidanceFor(s, outline.audience)}`)
    .join("\n");
}

function packText(pack: RaisePack): string {
  if (!pack.lines.length) return "(nothing yet)";
  return pack.lines.map((l) => `${l.id} [${SOURCE_LABEL_WORDS[l.label]}] ${l.text}`).join("\n");
}

function numbersText(pack: RaisePack): string {
  const out: string[] = [];
  if (pack.numbers.waitlist.hasData) out.push('waitlistSignups: sign-ups to the brand\'s launches each week, for the last 12 weeks. Ask with grain "week" for the chart and grain "total" for the number.');
  if (pack.numbers.growth.hasData) out.push("signupGrowth: the second half of the weeks against the first, as a percent.");
  (pack.numbers.launches ?? []).slice(0, 9).forEach((l, i) => out.push(`launchSignups with launch L${i + 1}: the people on the launch "${l.name}".`));
  return out.length ? out.join("\n") : "(none has data yet: leave a need instead)";
}

export function draftPrompt(pack: RaisePack, outline: Outline, input: Pick<DraftInput, "brief">, today: Date): string {
  return renderPrompt(DRAFT_PROMPT.id, {
    brand_name: pack.brandName || "the business",
    audience_words: audienceWords(outline.audience, outline.stage),
    outline: outlineText(outline),
    voice: pack.voice ?? "(none set: plain, warm and direct)",
    pack: packText(pack),
    authors: pack.authors.length ? pack.authors.map((a) => `${a.ref}: ${a.name}${a.role ? `, ${a.role}` : ""}`).join("\n") : "(none)",
    numbers: numbersText(pack),
    brief: clip(input.brief, 1500) || "(none)",
    today: today.toISOString().slice(0, 10),
  });
}

/** The answer's shape: enums for section, layout and meaning, no item counts (counts are checked in code). */
export function responseSchema(): Record<string, unknown> {
  const text = { type: "string" };
  const list = { type: "array", items: text };
  return {
    type: "object",
    properties: {
      title: text,
      slides: {
        type: "array",
        items: {
          type: "object",
          properties: {
            section: { type: "string", enum: [...SECTION_KEYS] },
            layout: { type: "string", enum: [...LAYOUT_KEYS] },
            headline: text,
            points: list,
            compare: {
              type: "object",
              properties: { leftTitle: text, rightTitle: text, rows: { type: "array", items: { type: "object", properties: { left: text, right: text }, required: ["left", "right"] } } },
            },
            people: { type: "array", items: { type: "object", properties: { author: text, line: text }, required: ["author", "line"] } },
            notes: text,
            blocks: {
              type: "array",
              items: {
                type: "object",
                properties: { key: text, meaning: { type: "string", enum: [...SERVER_MEANINGS] }, grain: { type: "string", enum: ["total", "week"] }, weeks: { type: "integer" }, launch: text },
                required: ["key", "meaning", "grain"],
              },
            },
            needs: list,
            sources: list,
          },
          required: ["section", "layout", "headline", "points", "notes"],
        },
      },
    },
    required: ["title", "slides"],
  };
}

// ----- Checking the answer ---------------------------------------------------------------------

const Str = z.string().catch("");
const ModelSlide = z.object({
  section: Str,
  layout: Str,
  headline: Str,
  points: z.array(Str).catch([]),
  compare: z
    .object({ leftTitle: Str, rightTitle: Str, rows: z.array(z.object({ left: Str, right: Str })).catch([]) })
    .nullish()
    .catch(null),
  people: z.array(z.object({ author: Str, line: Str })).catch([]),
  notes: Str,
  blocks: z.array(z.object({ key: Str, meaning: Str, grain: Str, weeks: z.number().nullish().catch(null), launch: z.string().nullish().catch(null) })).catch([]),
  needs: z.array(Str).catch([]),
  sources: z.array(Str).catch([]),
});
const ModelAnswer = z.object({ title: Str, slides: z.array(ModelSlide) });
type ModelSlide = z.infer<typeof ModelSlide>;

const MODEL_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The model's {{b1}} tokens renamed to the blocks' ids; any other token dropped. */
function renameTokens(text: string, ids: ReadonlyMap<string, string>, dropped: string[]): string {
  return text
    .replace(MODEL_TOKEN, (m, inner: string) => {
      const t = /^(b[1-3])(?::(period))?$/.exec(inner);
      const id = t ? ids.get(t[1]!) : undefined;
      if (!id) {
        dropped.push(m);
        return "";
      }
      return t![2] ? `{{${id}:period}}` : `{{${id}}}`;
    })
    .replace(/ {2,}/g, " ")
    .trim();
}

interface BuildCtx {
  outline: Outline;
  pack: RaisePack;
  reader: MetricReader;
  now: Date;
}

const WEEKS = new Set([4, 8, 12]);

/** The model's block asks, as server requests: a launch by its L number, the default window 12 weeks. */
function requestsOf(m: ModelSlide, pack: RaisePack, warnings: string[], n: number): Array<{ key: string; req: BlockRequest }> {
  const out: Array<{ key: string; req: BlockRequest }> = [];
  for (const b of m.blocks) {
    if (out.length >= L.blocks) break;
    if (!/^b[1-3]$/.test(b.key) || out.some((o) => o.key === b.key)) continue;
    if (!(SERVER_MEANINGS as readonly string[]).includes(b.meaning)) {
      warnings.push(`Slide ${n} asked for a number YouGrow doesn't hold, so it was left out.`);
      continue;
    }
    const meaning = b.meaning as BlockRequest["meaning"];
    const weeks = (b.weeks && WEEKS.has(b.weeks) ? b.weeks : 12) as 4 | 8 | 12;
    if (meaning === "launchSignups") {
      const i = /^L(\d+)$/.exec(b.launch ?? "")?.[1];
      const launch = i ? pack.numbers.launches?.[Number(i) - 1] : undefined;
      if (!launch) {
        warnings.push(`Slide ${n} asked for an unknown launch, so it was left out.`);
        continue;
      }
      out.push({ key: b.key, req: { meaning, grain: "total", launchId: launch.id } });
      continue;
    }
    out.push({ key: b.key, req: { meaning, grain: meaning === "waitlistSignups" && b.grain === "week" ? "week" : "total", weeks } });
  }
  return out;
}

/** The traction slide always carries the weekly sign-ups chart and its total, when there are sign-ups. */
function defaultRequests(section: SectionKey, pack: RaisePack): BlockRequest[] {
  if (section !== "traction" || !pack.numbers.waitlist.hasData) return [];
  return [
    { meaning: "waitlistSignups", grain: "week", weeks: 12 },
    { meaning: "waitlistSignups", grain: "total", weeks: 12 },
  ];
}

function needsFor(section: SectionKey, pack: RaisePack, extra: string[]): SlideNeed[] {
  const texts = [
    ...extra,
    ...pack.missing.filter((k) => MISSING_SECTION[k] === section).map((k) => MISSING_WORDS[k]),
    ...(AMOUNT_NEED[section] ? [AMOUNT_NEED[section]!] : []),
  ]
    .map((t) => clip(t, L.need))
    .filter(Boolean);
  return [...new Set(texts)].slice(0, L.needs).map((text) => ({ id: newId("nd"), text }));
}

async function filled(reqs: BlockRequest[], reader: MetricReader, warnings: string[]): Promise<{ blocks: MetricBlock[]; needs: string[] }> {
  const blocks: MetricBlock[] = [];
  const needs: string[] = [];
  for (const req of reqs) {
    const f = await fillBlock(reader, req);
    if (f.warning) warnings.push(f.warning);
    if (f.block.value === null) {
      if (f.need) needs.push(f.need);
      continue;
    }
    blocks.push(f.block);
  }
  return { blocks, needs };
}

/** One slide from the model's answer: checked, capped, numbers filled by the server. */
async function slideFrom(m: ModelSlide | undefined, i: number, c: BuildCtx, warnings: string[]): Promise<Slide> {
  const section = c.outline.sections[i]!;
  const n = i + 1;
  if (!m) return outlineSlide(section, c, "", warnings);
  const layout: LayoutKey = (LAYOUT_KEYS as readonly string[]).includes(m.layout) ? (m.layout as LayoutKey) : DEFAULT_LAYOUT[section];

  // Numbers: the model's asks, then the slide's defaults, all filled here. A block with no data
  // becomes a need, and its tokens go.
  const asked = requestsOf(m, c.pack, warnings, n);
  const ids = new Map<string, string>();
  const blocks: MetricBlock[] = [];
  const needTexts: string[] = [];
  for (const { key, req } of asked) {
    const f = await fillBlock(c.reader, req);
    if (f.warning) warnings.push(f.warning);
    if (f.block.value === null) {
      if (f.need) needTexts.push(f.need);
      continue;
    }
    ids.set(key, f.block.id);
    blocks.push(f.block);
  }
  const defaults = defaultRequests(section, c.pack).filter((d) => !asked.some((a) => a.req.meaning === d.meaning && a.req.grain === d.grain));
  const more = await filled(defaults, c.reader, warnings);
  blocks.push(...more.blocks.slice(0, Math.max(0, L.blocks - blocks.length)));
  needTexts.push(...more.needs);

  const dropped: string[] = [];
  const t = (s: string, max: number) => clip(renameTokens(s, ids, dropped), max);
  const headline = t(m.headline, L.headline);
  const points = m.points.map((p) => t(p, L.point)).filter(Boolean).slice(0, pointsCap(layout, section, c.outline.stage));
  const compare =
    layout === "compare" && m.compare && m.compare.rows.length
      ? {
          leftTitle: clip(m.compare.leftTitle, L.compareTitle) || "Today",
          rightTitle: clip(m.compare.rightTitle, L.compareTitle) || "With us",
          rows: m.compare.rows
            .map((r) => ({ left: t(r.left, L.compareCell), right: t(r.right, L.compareCell) }))
            .filter((r) => r.left || r.right)
            .slice(0, L.compareRows),
        }
      : undefined;
  if (dropped.length) warnings.push(`Slide ${n} named a number it didn't ask for, so it was left out.`);

  // People only from the brand's own team list, by A number.
  let people: Slide["people"];
  if (section === "team" || layout === "team") {
    const byRef = new Map(c.pack.authors.map((a) => [a.ref, a]));
    const picked: NonNullable<Slide["people"]> = [];
    for (const p of m.people) {
      const a = byRef.get(p.author.trim());
      if (!a) {
        warnings.push(`Slide ${n} named someone who isn't on your team list, so they were left out.`);
        continue;
      }
      if (picked.some((x) => x.authorId === a.id)) continue;
      picked.push({ name: a.name, role: a.role, line: clip(p.line, L.personLine) || clip(a.bio, L.personLine), authorId: a.id });
    }
    if (!picked.length) for (const a of c.pack.authors) picked.push({ name: a.name, role: a.role, line: clip(a.bio, L.personLine), authorId: a.id });
    people = picked.slice(0, L.people);
  }

  const known = new Set(c.pack.lines.map((l) => l.id));
  const notes = clip(m.notes, L.notes);
  return {
    id: newId("sl"),
    section,
    layout,
    headline: headline || (section === "cover" ? c.pack.brandName || SECTION_LABEL.cover : SECTION_LABEL[section]),
    points,
    ...(compare ? { compare } : {}),
    ...(people ? { people } : {}),
    blocks,
    notes,
    needs: needsFor(section, c.pack, [...m.needs, ...needTexts]),
    sources: [...new Set(m.sources.map((s) => s.trim()).filter((s) => known.has(s)))].slice(0, L.sources),
    ai: { headline: clip(headline, L.headline), points, notes, at: c.now.toISOString(), prompt: DRAFT_PROMPT_TAG },
  };
}

/** A slide of the outline alone: its section, default layout, the server's numbers and what it needs. No model words. */
async function outlineSlide(section: SectionKey, c: BuildCtx, title: string, warnings: string[]): Promise<Slide> {
  const { blocks, needs } = await filled(defaultRequests(section, c.pack), c.reader, warnings);
  const slideNeeds = needsFor(section, c.pack, needs);
  const people = section === "team" && c.pack.authors.length ? c.pack.authors.map((a) => ({ name: a.name, role: a.role, line: clip(a.bio, L.personLine), authorId: a.id })) : undefined;
  return {
    id: newId("sl"),
    section,
    layout: DEFAULT_LAYOUT[section],
    headline: section === "cover" ? title : SECTION_LABEL[section],
    points: [],
    ...(people ? { people } : {}),
    blocks,
    notes: "",
    needs: slideNeeds.length ? slideNeeds : [{ id: newId("nd"), text: OUTLINE_NEED }],
    sources: [],
  };
}

/** The outline as slides: what New deck saves without a model. */
export async function outlineDeck(c: BuildCtx, title: string, warnings: string[] = []): Promise<Slide[]> {
  const out: Slide[] = [];
  for (const section of c.outline.sections) out.push(await outlineSlide(section, c, title, warnings));
  return out;
}

/** The model's answer as slides, one per outline line in order; null when it can't be read at all. */
export async function slidesFromAnswer(answer: unknown, c: BuildCtx): Promise<{ title: string; slides: Slide[]; warnings: string[] } | null> {
  const parsed = ModelAnswer.safeParse(answer);
  if (!parsed.success || !parsed.data.slides.length) return null;
  const warnings: string[] = [];
  if (parsed.data.slides.length > c.outline.sections.length) warnings.push("The draft had more slides than the outline, so the extra ones were left out.");
  const slides: Slide[] = [];
  for (let i = 0; i < c.outline.sections.length; i += 1) slides.push(await slideFrom(parsed.data.slides[i], i, c, warnings));
  return { title: clip(parsed.data.title, L.title), slides, warnings: [...new Set(warnings)] };
}

/** Draft a new deck and save it as version 1. The caller has checked the switch, the role, brandCanUse and the limits. */
export async function draftDeck(ctx: TenantContext, input: DraftInput, deps: DraftDeps = {}): Promise<RaiseResult<Drafted>> {
  const stage = stageFor(input.audience, input.stage);
  const outline = outlineFor(input.audience, stage);
  const now = deps.now?.() ?? new Date();
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const reader = metricReader(ctx, { db: deps.db, ...deps.metrics, now: () => now });
  const pack = await raiseContext(ctx, { audience: input.audience, stage }, { db: deps.db, loadTenant: async () => tenant, ...deps.pack, reader });
  const c: BuildCtx = { outline, pack, reader, now };

  const generate = deps.generate ?? generateJsonWithSchema;
  const raw = await generate(draftPrompt(pack, outline, input, now), {
    schema: responseSchema(),
    timeoutMs: DRAFT_TIMEOUT_MS,
    temperature: 0.4,
    thinkingBudget: THINKING,
    usage: aiUsage(ctx, "raise_write", { db: deps.db, tenant }),
  }).catch(() => null);
  const answer = raw ? await slidesFromAnswer(parseFirstJson(raw), c) : null;

  const typedTitle = clip(input.title, L.title);
  const title = typedTitle || answer?.title || pack.brandName || kindLabel(input.audience, stage);
  const warnings = answer?.warnings ?? [];
  const slides = answer?.slides ?? (await outlineDeck(c, title, warnings));
  const saved = await createRaiseDoc(
    ctx,
    {
      audience: input.audience,
      stage,
      title,
      slides,
      sources: pack.lines,
      outline: outlineIdFor(input.audience, stage),
      ...(answer ? { made: { promptId: DRAFT_PROMPT.id, version: DRAFT_PROMPT.version, model: TEXT_MODEL } } : {}),
      by: answer ? "vizzy" : input.by,
      note: answer ? NOTE_WORDS.firstDraft : NOTE_WORDS.outline,
    },
    deps,
  );
  if (!saved.ok) return saved;
  return { ok: true, value: { doc: saved.value, drafted: Boolean(answer), warnings: [...new Set(warnings)] } };
}
