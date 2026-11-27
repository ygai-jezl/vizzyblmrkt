import { z } from "zod";
import { generateJsonWithSchema, parseFirstJson } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { aiUsage } from "@/lib/plans/meter";
import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import {
  ModelSlideSchema,
  audienceWords,
  authorsText,
  brandForPrompt,
  buildSlide,
  citeFor,
  clip,
  fenced,
  needsFor,
  numbersText,
  outlineSlide,
  packText,
  renameTokens,
  requestsOf,
  responseSchema,
  strayWarning,
  teamPeople,
  type BuildCtx,
  type ModelSlide,
} from "./draft";
import { LAYOUTS, pointsCap } from "./layouts";
import { fillBlock, metricReader, refreshBlocks, typedBlock, type BlockRequest, type MetricDeps, type MetricReader, type NumberChange } from "./metrics";
import { AMOUNT_NEED, DEFAULT_LAYOUT, MISSING_SECTION, SECTION_BRIEF, guidanceFor, outlineFor } from "./outlines";
import { raiseContext, type RaisePack, type RaisePackDeps } from "./pack";
import { saveRaiseVersion, type RaiseResult, type StoreDeps } from "./store";
import { citationsOut, labelWords, slideTextParts } from "./text";
import {
  BLOCK_UNITS,
  CURRENCIES,
  LAYOUT_KEYS,
  RAISE_DOC_LIMITS as L,
  SECTION_KEYS,
  newId,
  type LayoutKey,
  type MetricBlock,
  type PackLine,
  type RaiseDoc,
  type SectionKey,
  type Slide,
  type SlideNeed,
} from "./types";
import { BLOCK_SHORT, CHANGE_WARNINGS, MISSING_WORDS, NOTE_WORDS, OP_ISSUES, SECTION_LABEL } from "./words";

/**
 * Vizzy changing a saved deck (revise_raise_doc), one new version per request. Structural changes
 * (add a slide, remove, move, a layout, a number YouGrow fills, a number the person said in chat,
 * refresh the numbers) are done here in code and never reach the model. Text changes (rewrite a
 * slide, write its notes again, write a new slide) go to the model together in one call (prompt
 * raise.deck_revise, counted under raise_write), and code checks the answer as it checks a draft:
 * the model never writes a figure, a block already on a slide keeps its frozen value, and team
 * people come only from the brand's own list. Slides are named by their number in the version
 * Vizzy read; a deck that has moved on since is refused as stale. Always a draft: nothing is sent.
 */

export const REVISE_PROMPT = { id: "raise.deck_revise", version: 2 } as const;
export const REVISE_PROMPT_TAG = `${REVISE_PROMPT.id}@${REVISE_PROMPT.version}`;
export const REVISE_TIMEOUT_MS = 75_000;
const THINKING = 512;

// ----- The changes Vizzy can ask for -----------------------------------------------------------

const Pos = z.number().int().min(1);
const Ask = z.string().trim().min(1).max(600);
const Weeks = z.union([z.literal(4), z.literal(8), z.literal(12)]);

export const ReviseOpSchema = z.discriminatedUnion("change", [
  z.object({ change: z.literal("rewrite"), slide: Pos, ask: Ask }),
  z.object({ change: z.literal("notes"), slide: Pos, ask: Ask }),
  z.object({ change: z.literal("add"), after: z.number().int().min(0), section: z.enum(SECTION_KEYS), layout: z.enum(LAYOUT_KEYS).optional(), ask: z.string().trim().max(600).optional() }),
  z.object({ change: z.literal("remove"), slide: Pos }),
  z.object({ change: z.literal("move"), slide: Pos, to: Pos }),
  z.object({ change: z.literal("layout"), slide: Pos, layout: z.enum(LAYOUT_KEYS) }),
  z.object({ change: z.literal("number"), slide: Pos, meaning: z.enum(["waitlistSignups", "launchSignups", "signupGrowth"]), weeks: Weeks.optional(), launch: z.string().trim().max(80).optional() }),
  z.object({
    change: z.literal("typed_number"),
    slide: Pos,
    name: z.string().trim().min(1).max(L.typedName),
    value: z.number().finite().min(-L.maxValue).max(L.maxValue),
    unit: z.enum(BLOCK_UNITS),
    currency: z.enum(CURRENCIES).optional(),
    per: z.enum(["month", "year"]).optional(),
    from: z.string().trim().max(L.typedFrom).optional(),
    quote: z.string().trim().min(1).max(L.quote),
  }),
  z.object({ change: z.literal("refresh_numbers") }),
]);
export type ReviseOp = z.infer<typeof ReviseOpSchema>;

/** Each change checked on its own, so every problem comes back at once for Vizzy to fix. */
export function parseOps(raw: readonly unknown[]): { ok: true; ops: ReviseOp[] } | { ok: false; issues: string[] } {
  const ops: ReviseOp[] = [];
  const issues: string[] = [];
  raw.forEach((r, i) => {
    const p = ReviseOpSchema.safeParse(r);
    if (p.success) ops.push(p.data);
    else for (const issue of p.error.issues.slice(0, 4)) issues.push(`ops.${i}${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`);
  });
  return issues.length ? { ok: false, issues } : { ok: true, ops };
}

/** Whether a request only refreshes the numbers (it then counts under the numbers limit). Safe on ops not yet checked. */
export const onlyRefresh = (ops: readonly unknown[]) =>
  ops.length > 0 && ops.every((o) => typeof o === "object" && o !== null && (o as { change?: unknown }).change === "refresh_numbers");

/**
 * Whether the person's own words hold this number: its digits, with commas, spaces and currency
 * signs ignored, and not as part of a longer number. "$6,200 a month" holds 6200; "about 6k"
 * doesn't, so Vizzy asks for the figure rather than turning words into a number.
 */
export function quoteHas(value: number, quote: string): boolean {
  const said = quote.replace(/[,\s£$€]/g, "");
  const digits = String(Math.abs(value));
  if (!/^\d+(?:\.\d+)?$/.test(digits)) return false;
  const [whole, frac] = digits.split(".");
  const pattern = frac ? `${whole}\\.${frac}0*` : `${whole}(?:\\.0+)?`;
  return new RegExp(`(?<![\\d.])${pattern}(?!\\d)`).test(said);
}

// ----- Helpers ---------------------------------------------------------------------------------

/** The Needs a number on this slide answers: once the slide holds a number, it stops asking for one. */
export function settledNeeds(section: SectionKey, blocks: readonly MetricBlock[], needs: SlideNeed[]): SlideNeed[] {
  if (!blocks.length) return needs;
  const answered = new Set<string>();
  for (const k of ["demand", "market", "sales"] as const) if (MISSING_SECTION[k] === section) answered.add(MISSING_WORDS[k]);
  const amount = AMOUNT_NEED[section];
  if (amount && blocks.some((b) => b.unit === "money")) answered.add(amount);
  return needs.filter((n) => !answered.has(n.text));
}

const withNeed = (needs: SlideNeed[], text: string): SlideNeed[] =>
  needs.some((n) => n.text === text) || needs.length >= L.needs ? needs : [...needs, { id: newId("nd"), text: clip(text, L.need) }];

/**
 * The fresh pack's lines under the deck's own ids: a line the deck already holds keeps its id, so
 * older slides' sources still point at the right words, and a new one takes the next free id while
 * there is room (30 at most). `sources` is what the deck keeps.
 */
export function mergeLines(stored: readonly PackLine[], fresh: readonly PackLine[]): { lines: PackLine[]; sources: PackLine[] } {
  const key = (l: PackLine) => `${l.label}|${l.text}`;
  const byKey = new Map(stored.map((l) => [key(l), l]));
  const used = new Set(stored.map((l) => l.id));
  const sources = [...stored];
  const lines: PackLine[] = [];
  let next = 1;
  for (const l of fresh) {
    const have = byKey.get(key(l));
    if (have) {
      lines.push(have);
      continue;
    }
    if (sources.length >= L.sources) continue;
    while (used.has(`P${next}`)) next += 1;
    const line = { ...l, id: `P${next}` };
    used.add(line.id);
    byKey.set(key(line), line);
    sources.push(line);
    lines.push(line);
  }
  return { lines, sources };
}

// ----- The prompt ------------------------------------------------------------------------------

type TaskKind = "rewrite" | "notes" | "new";
interface Task {
  ref: string;
  kind: TaskKind;
  /** The slide it changes, or the new slide's id. */
  id: string;
  ask: string;
  section?: SectionKey;
  layout?: LayoutKey;
}


function slideText(s: Slide, n: number, now: Date): string {
  const lines = [`Slide ${n} (${s.section}, layout ${s.layout}):`, `Headline: ${fenced(s.headline)}`];
  for (const p of s.points) lines.push(`Point: ${fenced(p)}`);
  if (s.compare) {
    lines.push(`Columns: ${fenced(s.compare.leftTitle)} | ${fenced(s.compare.rightTitle)}`);
    for (const r of s.compare.rows) lines.push(`Row: ${fenced(r.left)} | ${fenced(r.right)}`);
  }
  for (const p of s.people ?? []) lines.push(`Person: ${fenced(p.name)}, ${fenced(p.role)}: ${fenced(p.line)}`);
  for (const b of s.blocks) lines.push(`Number {{${b.id}}}: ${fenced(b.display) || "none yet"} (${fenced(b.name)}${b.periodWords ? `, ${fenced(b.periodWords)}` : ""}, ${fenced(labelWords(b, now))})`);
  if (s.notes) lines.push(`Notes: ${fenced(s.notes)}`);
  for (const need of s.needs) lines.push(`Needs: ${fenced(need.text)}`);
  return lines.join("\n");
}

function taskText(t: Task, n: number, audience: RaiseDoc["audience"]): string {
  const asked = t.ask ? ` Asked: "${fenced(t.ask)}"` : "";
  if (t.kind === "rewrite") return `${t.ref}: rewrite slide ${n}.${asked}`;
  if (t.kind === "notes") return `${t.ref}: notes for slide ${n}.${asked}`;
  const section = t.section!;
  return `${t.ref}: new slide ${n}, section ${section} (${SECTION_LABEL[section]}), layout ${t.layout}: ${SECTION_BRIEF[section]}. ${guidanceFor(section, audience)}${asked}`;
}

export function revisePrompt(doc: RaiseDoc, slides: readonly Slide[], tasks: readonly Task[], pack: RaisePack, now: Date): string {
  const pos = new Map(slides.map((s, i) => [s.id, i + 1]));
  const newIds = new Set(tasks.filter((t) => t.kind === "new").map((t) => t.id));
  return renderPrompt(REVISE_PROMPT.id, {
    brand_name: brandForPrompt(pack.brandName),
    audience_words: audienceWords(doc.audience, doc.stage),
    deck: slides
      .filter((s) => !newIds.has(s.id))
      .map((s) => slideText(s, pos.get(s.id)!, now))
      .join("\n\n"),
    tasks: tasks.map((t) => taskText(t, pos.get(t.id) ?? 0, doc.audience)).join("\n"),
    voice: fenced(pack.voice) || "(none set: plain, warm and direct)",
    pack: packText(pack),
    authors: authorsText(pack),
    numbers: numbersText(pack),
    today: now.toISOString().slice(0, 10),
  });
}

/** The answer's shape: the draft's slide shape, named by task instead of by section and layout. */
export function reviseSchema(): Record<string, unknown> {
  const draft = responseSchema() as { properties: { slides: { items: { properties: Record<string, unknown> } } } };
  const { section: _s, layout: _l, ...props } = draft.properties.slides.items.properties;
  return {
    type: "object",
    properties: { slides: { type: "array", items: { type: "object", properties: { task: { type: "string" }, ...props }, required: ["task", "notes"] } } },
    required: ["slides"],
  };
}

const ReviseAnswer = z.object({ slides: z.array(ModelSlideSchema.extend({ task: z.string().catch("") })) });

/** The model's slides by task id; null when the answer can't be read at all. */
function answerOf(raw: unknown): Map<string, ModelSlide> | null {
  const p = ReviseAnswer.safeParse(raw);
  if (!p.success) return null;
  const out = new Map<string, ModelSlide>();
  for (const s of p.data.slides) if (/^T\d$/.test(s.task.trim()) && !out.has(s.task.trim())) out.set(s.task.trim(), s);
  return out;
}

// ----- Text changes ----------------------------------------------------------------------------

interface TextCtx extends BuildCtx {
  stage: RaiseDoc["stage"];
}

/** A slide rewritten as the model answered: its own blocks kept frozen, new ones filled by the server. */
async function rewritten(s: Slide, m: ModelSlide, n: number, c: TextCtx, warnings: string[]): Promise<Slide> {
  const keep = new Set(s.blocks.map((b) => b.id));
  const asked = requestsOf(m, c.pack, warnings, n, L.blocks - s.blocks.length);
  const ids = new Map<string, string>();
  const blocks = [...s.blocks];
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
  const dropped: string[] = [];
  const cite = citeFor(c);
  const stray = new Set<string>();
  const cleaned = (text: string) => {
    const r = citationsOut(text, cite);
    r.stray.forEach((x) => stray.add(x));
    return r.text;
  };
  const t = (text: string, max: number) => clip(cleaned(renameTokens(text, ids, dropped, keep)), max);
  const headline = t(m.headline, L.headline) || s.headline;
  const points = m.points.map((p) => t(p, L.point)).filter(Boolean).slice(0, pointsCap(s.layout, s.section, c.stage));
  const notes = t(m.notes, L.notes) || s.notes;
  const compare =
    s.layout === "compare" && m.compare && m.compare.rows.length
      ? {
          leftTitle: clip(m.compare.leftTitle, L.compareTitle) || s.compare?.leftTitle || "Today",
          rightTitle: clip(m.compare.rightTitle, L.compareTitle) || s.compare?.rightTitle || "With us",
          rows: m.compare.rows
            .map((r) => ({ left: t(r.left, L.compareCell), right: t(r.right, L.compareCell) }))
            .filter((r) => r.left || r.right)
            .slice(0, L.compareRows),
        }
      : undefined;
  const people = (s.section === "team" || s.layout === "team") && m.people.length ? teamPeople(m.people, c.pack, n, warnings, cite, stray) : undefined;
  if (dropped.length) warnings.push(`Slide ${n} named a number it didn't ask for, so it was left out.`);
  if (stray.size) warnings.push(strayWarning(n, [...stray]));
  const known = new Set(c.pack.lines.map((l) => l.id));
  const sources = [...new Set(m.sources.map((x) => x.trim()).filter((x) => known.has(x)))].slice(0, L.sources);
  return {
    ...s,
    headline,
    points,
    ...(compare ? { compare } : {}),
    ...(people ? { people } : {}),
    blocks,
    notes,
    needs: settledNeeds(s.section, blocks, needsFor(s.section, c.pack, [...m.needs, ...needTexts])),
    sources: sources.length ? sources : s.sources,
    ai: { headline, points, notes, at: c.now.toISOString(), prompt: REVISE_PROMPT_TAG },
  };
}

/** Only the slide's notes again, as the model answered; the rest of the slide as it was. */
function withNotes(s: Slide, m: ModelSlide, n: number, c: TextCtx, warnings: string[]): Slide | null {
  const dropped: string[] = [];
  const said = citationsOut(renameTokens(m.notes, new Map(), dropped, new Set(s.blocks.map((b) => b.id))), citeFor(c));
  const notes = clip(said.text, L.notes);
  if (!notes) return null;
  if (said.stray.length) warnings.push(strayWarning(n, said.stray));
  return { ...s, notes, ai: { headline: s.ai?.headline ?? s.headline, points: s.ai?.points ?? s.points, notes, at: c.now.toISOString(), prompt: REVISE_PROMPT_TAG } };
}

// ----- Revise ----------------------------------------------------------------------------------

export interface ReviseInput {
  ops: ReviseOp[];
  /** The version Vizzy read: slides are named by their number in it. */
  baseVersion: number;
  /** Vizzy's change note; without one the server writes it from the difference. */
  note?: string;
}

export interface ReviseDeps extends StoreDeps {
  pack?: Omit<RaisePackDeps, "reader">;
  metrics?: MetricDeps;
  generate?: typeof generateJsonWithSchema;
  loadTenant?: (id: string) => Promise<Tenant | null>;
}

export interface Revised {
  doc: RaiseDoc;
  /** False when nothing changed: no new version was made. */
  saved: boolean;
  warnings: string[];
  /** The numbers a refresh moved. */
  changed: NumberChange[];
}

const fail = (status: number, error: string, extra: { issues?: string[]; version?: number } = {}): RaiseResult<never> => ({ ok: false, status, error, ...extra });

/**
 * Apply Vizzy's changes to the deck as it is (version `baseVersion`) and save one new version, by
 * Vizzy. The caller has checked the switch, the role, brandCanUse and the limits.
 */
export async function reviseDeck(ctx: TenantContext, doc: RaiseDoc, input: ReviseInput, deps: ReviseDeps = {}): Promise<RaiseResult<Revised>> {
  if (doc.version !== input.baseVersion) return fail(409, "stale_version", { version: doc.version });
  const now = deps.now?.() ?? new Date();
  const reader: MetricReader = metricReader(ctx, { db: deps.db, ...deps.metrics, now: () => now });
  const read = doc.current.slides;
  const work: Slide[] = [...read];
  const issues: string[] = [];
  const warnings: string[] = [];
  const tasks: Task[] = [];
  const removed = new Set<string>();
  let refresh = false;

  const idAt = (pos: number, i: number): string | null => {
    const s = read[pos - 1];
    if (!s) issues.push(`ops.${i}: ${OP_ISSUES.noSlide(pos, read.length)}`);
    else if (removed.has(s.id)) issues.push(`ops.${i}: ${OP_ISSUES.removed(pos)}`);
    else return s.id;
    return null;
  };
  const at = (id: string) => work.findIndex((s) => s.id === id);
  const update = (id: string, f: (s: Slide) => Slide) => {
    const i = at(id);
    work[i] = f(work[i]!);
  };

  for (const [i, op] of input.ops.entries()) {
    switch (op.change) {
      case "rewrite":
      case "notes": {
        const id = idAt(op.slide, i);
        if (id) tasks.push({ ref: `T${tasks.length + 1}`, kind: op.change, id, ask: op.ask });
        break;
      }
      case "add": {
        let index = 0;
        if (op.after > 0) {
          const id = idAt(op.after, i);
          if (!id) break;
          index = at(id) + 1;
        }
        if (work.length >= L.slides) {
          issues.push(`ops.${i}: ${OP_ISSUES.tooMany}`);
          break;
        }
        const id = newId("sl");
        const layout = op.layout ?? DEFAULT_LAYOUT[op.section];
        work.splice(index, 0, { id, section: op.section, layout, headline: SECTION_LABEL[op.section], points: [], blocks: [], notes: "", needs: [], sources: [] });
        tasks.push({ ref: `T${tasks.length + 1}`, kind: "new", id, ask: op.ask ?? "", section: op.section, layout });
        break;
      }
      case "remove": {
        const id = idAt(op.slide, i);
        if (!id) break;
        if (work.length <= L.minSlides) issues.push(`ops.${i}: ${OP_ISSUES.tooFew}`);
        else if (tasks.some((t) => t.id === id)) issues.push(`ops.${i}: ${OP_ISSUES.removed(op.slide)}`);
        else {
          work.splice(at(id), 1);
          removed.add(id);
        }
        break;
      }
      case "move": {
        const id = idAt(op.slide, i);
        if (!id) break;
        if (op.to > work.length) {
          issues.push(`ops.${i}: ${OP_ISSUES.noPlace(op.to, work.length)}`);
          break;
        }
        const [s] = work.splice(at(id), 1);
        work.splice(op.to - 1, 0, s!);
        break;
      }
      case "layout": {
        const id = idAt(op.slide, i);
        if (id) update(id, (s) => ({ ...s, layout: op.layout }));
        break;
      }
      case "number":
      case "typed_number": {
        const id = idAt(op.slide, i);
        if (!id) break;
        const s = work[at(id)]!;
        if (s.blocks.length >= L.blocks) {
          issues.push(`ops.${i}: ${OP_ISSUES.full(op.slide)}`);
          break;
        }
        if (op.change === "typed_number") {
          if (!quoteHas(op.value, op.quote)) return fail(422, "quote_mismatch", { issues: [`ops.${i}.quote: ${OP_ISSUES.notInQuote(String(Math.abs(op.value)))}`] });
          const b = typedBlock(
            { name: op.name, value: op.value, unit: op.unit, currency: op.currency, per: op.per ?? null, from: op.from },
            { typedBy: ctx.userId ?? "vizzy", saidInChat: true, quote: op.quote },
            now,
          );
          const blocks = [...s.blocks, b];
          update(id, (x) => ({ ...x, blocks, needs: settledNeeds(x.section, blocks, x.needs) }));
          if (LAYOUTS[s.layout].blocks === 0) warnings.push(CHANGE_WARNINGS.layoutHidesNumbers(op.slide));
          break;
        }
        let req: BlockRequest;
        if (op.meaning === "launchSignups") {
          if (!op.launch) {
            issues.push(`ops.${i}.launch: ${OP_ISSUES.needsLaunch}`);
            break;
          }
          const launches = await reader.launches();
          if (!launches) {
            issues.push(`ops.${i}: ${OP_ISSUES.noPeopleList}`);
            break;
          }
          const want = op.launch.toLowerCase();
          const launch = launches.find((l) => l.id === op.launch) ?? launches.find((l) => l.name.trim().toLowerCase() === want);
          if (!launch) {
            issues.push(`ops.${i}.launch: ${OP_ISSUES.noLaunch(op.launch)}`);
            break;
          }
          req = { meaning: "launchSignups", grain: "total", launchId: launch.id };
        } else {
          // On a chart slide with no chart yet, sign-ups come week by week.
          const weekly = op.meaning === "waitlistSignups" && s.layout === "chart" && !s.blocks.some((b) => b.series?.length);
          req = { meaning: op.meaning, grain: weekly ? "week" : "total", weeks: op.weeks ?? 12 };
        }
        const f = await fillBlock(reader, req);
        if (f.block.value === null) {
          warnings.push(CHANGE_WARNINGS.noData(op.slide, BLOCK_SHORT[op.meaning]));
          if (f.need) update(id, (x) => ({ ...x, needs: withNeed(x.needs, f.need!) }));
          break;
        }
        const blocks = [...s.blocks, f.block];
        update(id, (x) => ({ ...x, blocks, needs: settledNeeds(x.section, blocks, x.needs) }));
        if (LAYOUTS[s.layout].blocks === 0) warnings.push(CHANGE_WARNINGS.layoutHidesNumbers(op.slide));
        break;
      }
      case "refresh_numbers":
        refresh = true;
        break;
    }
  }
  if (issues.length) return fail(422, "invalid_ops", { issues });

  // Text changes: one model call for all of them.
  let sources: PackLine[] | undefined;
  if (tasks.length) {
    const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
    const fresh = await raiseContext(ctx, { audience: doc.audience, stage: doc.stage }, { db: deps.db, loadTenant: async () => tenant, ...deps.pack, reader });
    const merged = mergeLines(doc.sources, fresh.lines);
    if (merged.sources.length > doc.sources.length) sources = merged.sources;
    // The deck as it is and what was asked are words the model was shown: an id among them stays.
    const shown = [...doc.current.slides.flatMap((x) => [...slideTextParts(x), x.notes, ...(x.people ?? []).map((p) => p.line)]), ...tasks.map((x) => x.ask ?? "")];
    const c: TextCtx = { outline: outlineFor(doc.audience, doc.stage), pack: { ...fresh, lines: merged.lines }, reader, now, stage: doc.stage, shown };

    const generate = deps.generate ?? generateJsonWithSchema;
    const raw = await generate(revisePrompt(doc, work, tasks, c.pack, now), {
      schema: reviseSchema(),
      timeoutMs: REVISE_TIMEOUT_MS,
      temperature: 0.4,
      thinkingBudget: THINKING,
      usage: aiUsage(ctx, "raise_write", { db: deps.db, tenant }),
    }).catch(() => null);
    const answer = raw ? answerOf(parseFirstJson(raw)) : null;
    // A rewrite with no answer at all saves nothing; a new slide falls back to its outline.
    if (!answer && tasks.some((t) => t.kind !== "new")) return fail(502, "revise_failed");

    for (const t of tasks) {
      const m = answer?.get(t.ref);
      const n = at(t.id) + 1;
      const s = work[n - 1]!;
      if (t.kind === "new") {
        const made = m
          ? await buildSlide(m, { section: t.section!, n, layout: t.layout, prompt: REVISE_PROMPT_TAG }, c, warnings)
          : (warnings.push(CHANGE_WARNINGS.addOutline(n)), await outlineSlide(t.section!, c, doc.title, warnings, t.layout));
        work[n - 1] = { ...made, id: t.id };
      } else if (t.kind === "rewrite") {
        if (m) work[n - 1] = await rewritten(s, m, n, c, warnings);
        else warnings.push(CHANGE_WARNINGS.notRewritten(n));
      } else {
        const next = m ? withNotes(s, m, n, c, warnings) : null;
        if (next) work[n - 1] = next;
        else warnings.push(CHANGE_WARNINGS.emptyNotes(n));
      }
    }
  }

  let changed: NumberChange[] = [];
  let slides = work;
  if (refresh) {
    const r = await refreshBlocks(reader, work);
    slides = r.slides;
    changed = r.changed;
  }

  const note =
    clip(input.note, L.note) || (onlyRefresh(input.ops) && changed.length ? NOTE_WORDS.refreshed(changed.map((x) => `slide ${x.slideN} ${x.name} ${x.from} to ${x.to}`)) : undefined);
  const saved = await saveRaiseVersion(ctx, doc.id, { baseVersion: input.baseVersion, title: doc.title, slides, note, by: "vizzy", keepAi: false, ...(sources ? { sources } : {}) }, deps);
  if (!saved.ok) return saved;
  return { ok: true, value: { doc: saved.value.doc, saved: saved.value.saved, warnings: [...new Set(warnings)], changed } };
}
