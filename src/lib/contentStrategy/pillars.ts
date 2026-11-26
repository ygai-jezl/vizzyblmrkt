import { generateTextWithDeadline, parseFirstJson, type AiUsage } from "@/lib/agents/gemini";
import { getPrompt, renderPrompt } from "@/lib/agents/prompts/registry";
import { TEXT_MODEL } from "@/lib/agents/modelConfig";
import { fold } from "@/lib/brandMap/changes";
import { clean, fence, hasAddress, oneLine } from "@/lib/brandMap/lineChecks";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { CONTENT_STRATEGY_LIMITS as L, NOT_ARTICLE_KINDS, PAGE_KIND_LABEL, type ContentPillar, type PlanMade } from "@/lib/types/contentStrategy";
import type { MadeSlot } from "./slots";
import { newPillarId } from "./store";

/**
 * Pillars: the 3 to 6 big themes the plan's slots fall into, each with a hub (a subject's home
 * page on the brand's site, or a hub slot to write first).
 *
 *  - From the brand map's groups when they are set: at least 3 groups hold slots, and most slots
 *    sit in one. The biggest 6 become pillars.
 *  - Otherwise ONE Gemini call names and groups the slots (`content.strategy_plan`), and names
 *    the slots that merge several questions. Code checks every slot number, the count and each
 *    line (one line, no dashes, none of the AI tells, no address); a slot the model left out joins
 *    the pillar most of its subject's slots are in.
 *  - With no model, or an answer that doesn't check out, the biggest subjects become pillars.
 */

export const PLAN_PROMPT = "content.strategy_plan";
/** Slots the model reads: the most focused and biggest first. */
const MAX_PROMPT_SLOTS = 150;
const PLAN_MS = 45_000;
/** Most slots in a group means the brand has grouped its map. */
const GROUPED_SHARE = 0.6;

/** A subject as pillars read it. */
export interface PillarSubject {
  id: string;
  name: string;
  groupId: string | null;
  home: string | null;
}

export interface PillarGroup {
  id: string;
  name: string;
}

export interface Pillared {
  pillars: ContentPillar[];
  /** Slot id → pillar id. */
  of: Map<string, string>;
  /** Better titles for slots that merge several questions, by slot id. */
  titles: Map<string, string>;
  /** Hub slots named by the model, by pillar id. */
  hubs: Map<string, string>;
  made: PlanMade | null;
  from: ContentPillar["from"];
}

const leadSubject = (s: MadeSlot) => s.subjectIds[0] ?? "";
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Pillars from the brand map's groups, or null when the map isn't grouped enough. Pure, apart from new ids. */
export function pillarsFromGroups(slots: MadeSlot[], subjects: ReadonlyMap<string, PillarSubject>, groups: PillarGroup[]): Pillared | null {
  const known = new Map(groups.map((g) => [g.id, g] as const));
  const count = new Map<string, number>();
  let grouped = 0;
  for (const s of slots) {
    const g = subjects.get(leadSubject(s))?.groupId;
    if (!g || !known.has(g)) continue;
    grouped += 1;
    count.set(g, (count.get(g) ?? 0) + 1);
  }
  if (count.size < L.pillarsMin || grouped < slots.length * GROUPED_SHARE) return null;
  const top = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, L.pillars);
  const pillarOfGroup = new Map<string, string>();
  const pillars: ContentPillar[] = top.map(([gid]) => {
    const id = newPillarId();
    pillarOfGroup.set(gid, id);
    return { id, name: cut(known.get(gid)!.name, L.pillarName), about: "", from: "groups", groupId: gid, hub: null };
  });
  const of = new Map<string, string>();
  for (const s of slots) {
    const p = pillarOfGroup.get(subjects.get(leadSubject(s))?.groupId ?? "");
    if (p) of.set(s.id, p);
  }
  return { pillars, of, titles: new Map(), hubs: new Map(), made: null, from: "groups" };
}

/** Pillars from the biggest subjects, when nothing better is to hand. Pure, apart from new ids. */
export function pillarsFromSubjects(slots: MadeSlot[], subjects: ReadonlyMap<string, PillarSubject>): Pillared {
  const count = new Map<string, number>();
  for (const s of slots) if (subjects.has(leadSubject(s))) count.set(leadSubject(s), (count.get(leadSubject(s)) ?? 0) + 1);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, L.pillars);
  const pillarOf = new Map<string, string>();
  const pillars: ContentPillar[] = top.map(([sid]) => {
    const id = newPillarId();
    pillarOf.set(sid, id);
    return { id, name: cut(subjects.get(sid)!.name, L.pillarName), about: "", from: "subjects", groupId: null, hub: null };
  });
  const of = new Map<string, string>();
  for (const s of slots) {
    const p = pillarOf.get(leadSubject(s));
    if (p) of.set(s.id, p);
  }
  return { pillars, of, titles: new Map(), hubs: new Map(), made: null, from: "subjects" };
}

/** What the plan call reads. */
export interface PlanCallInput {
  brandName: string;
  category: string;
  identity: string[];
  strategy: string[];
  /** The slots in the order they are numbered, with the words of their other questions. */
  slots: Array<{ slot: MadeSlot; others: string[]; subject: string }>;
}

/** The slots the model reads, numbered from 1: the most focused and biggest first. Pure. */
export function promptSlots(slots: MadeSlot[]): MadeSlot[] {
  return [...slots]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.facts.focus - a.s.facts.focus || b.s.questionIds.length - a.s.questionIds.length || b.s.coveredBy.length - a.s.coveredBy.length || a.i - b.i)
    .slice(0, MAX_PROMPT_SLOTS)
    .map((x) => x.s);
}

/** The prompt, every outside text fenced. Pure. */
export function planPrompt(input: PlanCallInput, today: string): string {
  const lines = input.slots.map(({ slot, others, subject }, k) => {
    const more = others.length ? ` (also asked as: ${others.slice(0, 2).map((t) => `"${cut(oneLine(t), 100)}"`).join("; ")})` : "";
    const live = slot.coveredBy.length ? `${slot.coveredBy.length} live` : "nothing live";
    const notArticle = NOT_ARTICLE_KINDS.has(slot.kind) ? ", not an article" : "";
    return `S${k + 1}. "${cut(oneLine(slot.title), 120)}"${more} · ${slot.stage} · ${PAGE_KIND_LABEL[slot.kind]}${notArticle} · ${live} · subject: ${cut(oneLine(subject), 60) || "none"}`;
  });
  return renderPrompt(PLAN_PROMPT, {
    brand_name: oneLine(input.brandName).replace(/"/g, " ").slice(0, 120) || "(not named)",
    category: input.category ? `, in the category "${oneLine(input.category).replace(/"/g, " ").slice(0, 80)}"` : "",
    today,
    identity: fence("brand", input.identity.join("\n") || "(not set yet)"),
    strategy: fence("strategy", input.strategy.join("\n") || "(none approved yet)"),
    slots: fence("slots", lines.join("\n")),
    pillars_min: L.pillarsMin,
    pillars_max: L.pillars,
  });
}

/** A line of copy that keeps to house style and holds no address, or "" when it can't. */
function lineOf(raw: unknown, max: number): string {
  const s = clean(typeof raw === "string" ? raw : "");
  if (!s || s.length > max || hasAddress(s) || dashesIn(s).length || aiTellsIn(s).length) return "";
  return s;
}

const slotRef = (raw: unknown, n: number): number | null => {
  const m = /^S(\d{1,4})$/i.exec(typeof raw === "string" ? raw.trim() : "");
  const k = m ? Number(m[1]) : NaN;
  return Number.isInteger(k) && k >= 1 && k <= n ? k - 1 : null;
};

/**
 * Check what the model proposed against the slots it was handed: 3 to 6 pillars with a name each,
 * each slot in one pillar at most, the hub one of its own slots, and every line in house style.
 * Null when fewer than 3 pillars check out. A slot the model left out joins the pillar most of its
 * subject's slots went to. Pure, apart from new ids.
 */
export function checkPillars(raw: unknown, listed: MadeSlot[], all: MadeSlot[]): Omit<Pillared, "made" | "from"> | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pillars: ContentPillar[] = [];
  const of = new Map<string, string>();
  const hubs = new Map<string, string>();
  const names = new Set<string>();
  for (const p of Array.isArray(r.pillars) ? (r.pillars as Array<Record<string, unknown>>) : []) {
    if (pillars.length >= L.pillars) break;
    const name = lineOf(p?.name, L.pillarName);
    if (!name || names.has(fold(name))) continue;
    const mine = (Array.isArray(p?.slots) ? (p.slots as unknown[]) : []).map((x) => slotRef(x, listed.length)).filter((k): k is number => k !== null && !of.has(listed[k]!.id));
    if (!mine.length) continue;
    const id = newPillarId();
    names.add(fold(name));
    for (const k of mine) of.set(listed[k]!.id, id);
    const hub = slotRef(p?.hub, listed.length);
    if (hub !== null && of.get(listed[hub]!.id) === id && !NOT_ARTICLE_KINDS.has(listed[hub]!.kind)) hubs.set(id, listed[hub]!.id);
    pillars.push({ id, name, about: lineOf(p?.about, L.pillarAbout), from: "vizzy", groupId: null, hub: null });
  }
  if (pillars.length < L.pillarsMin) return null;

  // A slot left out (or past what the model read) goes where most of its subject's slots went.
  const bySubject = new Map<string, Map<string, number>>();
  for (const s of all) {
    const p = of.get(s.id);
    if (!p) continue;
    const m = bySubject.get(leadSubject(s)) ?? new Map<string, number>();
    m.set(p, (m.get(p) ?? 0) + 1);
    bySubject.set(leadSubject(s), m);
  }
  for (const s of all) {
    if (of.has(s.id)) continue;
    const best = [...(bySubject.get(leadSubject(s)) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) of.set(s.id, best[0]);
  }

  const titles = new Map<string, string>();
  for (const t of Array.isArray(r.titles) ? (r.titles as Array<Record<string, unknown>>) : []) {
    const k = slotRef(t?.slot, listed.length);
    const title = lineOf(t?.title, 100);
    if (k !== null && title && listed[k]!.questionIds.length > 1) titles.set(listed[k]!.id, title);
  }
  return { pillars, of, titles, hubs };
}

export interface PlanCallDeps {
  generate?: typeof generateTextWithDeadline;
  modelReady?: () => boolean;
  usage: AiUsage;
}

/**
 * The pillars: the brand map's groups when set, else one model call, else the biggest subjects.
 * `call` builds the model's input only when it is needed.
 */
export async function choosePillars(
  slots: MadeSlot[],
  ctx: { subjects: ReadonlyMap<string, PillarSubject>; groups: PillarGroup[]; today: string; call: (listed: MadeSlot[]) => PlanCallInput },
  deps: PlanCallDeps,
): Promise<Pillared> {
  const fromGroups = pillarsFromGroups(slots, ctx.subjects, ctx.groups);
  if (fromGroups) return fromGroups;
  if ((deps.modelReady ?? (() => true))() && slots.length) {
    const listed = promptSlots(slots);
    const raw = await (deps.generate ?? generateTextWithDeadline)(planPrompt(ctx.call(listed), ctx.today), {
      timeoutMs: PLAN_MS,
      json: true,
      temperature: 0.3,
      thinkingBudget: 1024,
      usage: deps.usage,
    }).catch(() => null);
    const parsed = raw ? parseFirstJson(raw) : null;
    const checked = parsed ? checkPillars(parsed, listed, slots) : null;
    if (checked) return { ...checked, made: { promptId: PLAN_PROMPT, version: getPrompt(PLAN_PROMPT).version, model: TEXT_MODEL }, from: "vizzy" };
  }
  return pillarsFromSubjects(slots, ctx.subjects);
}

/**
 * Each pillar's hub: the home page of its biggest subject that has one, else the hub slot the model
 * named, else its broadest article slot (most questions, learn and guides first). Returns the hub
 * slot ids. Pure.
 */
export function hubsOf(pillars: ContentPillar[], slots: Array<Pick<MadeSlot, "id" | "questionIds" | "subjectIds" | "stage" | "kind">>, of: ReadonlyMap<string, string>, subjects: ReadonlyMap<string, PillarSubject>, named: ReadonlyMap<string, string> = new Map()): Set<string> {
  const hubSlots = new Set<string>();
  for (const p of pillars) {
    const mine = slots.filter((s) => of.get(s.id) === p.id);
    const subjectCount = new Map<string, number>();
    for (const s of mine) for (const sub of s.subjectIds.slice(0, 1)) subjectCount.set(sub, (subjectCount.get(sub) ?? 0) + 1);
    const withHome = [...subjectCount.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => subjects.get(id)).find((s) => s?.home);
    if (withHome?.home) {
      p.hub = { kind: "home", url: withHome.home, subjectId: withHome.id };
      continue;
    }
    const pick =
      mine.find((s) => s.id === named.get(p.id)) ??
      mine
        .filter((s) => !NOT_ARTICLE_KINDS.has(s.kind))
        .map((s, i) => ({ s, i }))
        .sort((a, b) => b.s.questionIds.length - a.s.questionIds.length || Number(b.s.stage === "learn") - Number(a.s.stage === "learn") || Number(b.s.kind === "guide") - Number(a.s.kind === "guide") || a.i - b.i)[0]?.s;
    if (pick) {
      p.hub = { kind: "slot", slotId: pick.id };
      hubSlots.add(pick.id);
    }
  }
  return hubSlots;
}
