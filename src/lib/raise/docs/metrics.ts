import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { isOneViewEnabled } from "@/lib/audience/flags";
import { sourceNames } from "@/lib/audience/peopleList";
import { loadWeeklySignups, type WeekPoint } from "@/lib/insights/overview";
import { dayWords, formatValue, periodWordsFor } from "./text";
import { RAISE_DOC_LIMITS as L, newId, type MetricBlock, type ServerMeaning, type Slide } from "./types";
import { BLOCK_NAME, BLOCK_SHORT, MISSING_WORDS } from "./words";

/**
 * Metric blocks: the numbers on a slide. The server fills YouGrow's own numbers by meaning key
 * (src/lib/metrics/meanings.ts), each with where it came from and when, so a figure is never the
 * model's or a guess. Sign-ups come from loadWeeklySignups, the same reads Insights and Vizzy's
 * get_insights_summary use, so the numbers match for the same moment. People on a launch count one
 * launch's list (AUDIENCE_ONE_VIEW_ENABLED), never everyone in People, which can hold investors and
 * partners. No data gives a value of null and a Needs callout, never 0. A number a person types is
 * a typed block, stamped with who typed it and when.
 */

/** A server block a slide asks for. */
export interface BlockRequest {
  id?: string;
  meaning: ServerMeaning;
  grain: "total" | "week";
  weeks?: 4 | 8 | 12;
  launchId?: string;
}

export interface LaunchCount {
  id: string;
  name: string;
  count: number;
}

export interface MetricDeps {
  db?: FirestoreLike;
  now?: () => Date;
  /** Twelve rolling 7 day windows of sign-ups, oldest first (loadWeeklySignups). */
  weekly?: (ctx: TenantContext, now: Date) => Promise<WeekPoint[]>;
  /** Each launch with how many different people are on it, or null while the one People list is off. */
  launches?: (ctx: TenantContext) => Promise<LaunchCount[] | null>;
}

/** The reads one draft, save or refresh shares: each made at most once. */
export interface MetricReader {
  now: Date;
  weekly(): Promise<WeekPoint[]>;
  launches(): Promise<LaunchCount[] | null>;
}

/** Each launch's people: one count per launch tag, the count People shows for that launch. Never the total. */
export async function launchCounts(ctx: TenantContext, db?: FirestoreLike): Promise<LaunchCount[] | null> {
  if (!isOneViewEnabled()) return null;
  const names = await sourceNames(ctx, db);
  const repo = forTenant(ctx, db).contacts;
  return Promise.all([...names.launches].map(async ([id, name]) => ({ id, name, count: await repo.count([["memberOf", "array-contains", `launch:${id}`]]) })));
}

export function metricReader(ctx: TenantContext, deps: MetricDeps = {}): MetricReader {
  const now = deps.now?.() ?? new Date();
  let weekly: Promise<WeekPoint[]> | null = null;
  let launches: Promise<LaunchCount[] | null> | null = null;
  return {
    now,
    weekly: () => (weekly ??= (deps.weekly ?? ((c, n) => loadWeeklySignups(c, n, deps.db)))(ctx, now).catch(() => [])),
    launches: () => (launches ??= (deps.launches ?? ((c) => launchCounts(c, deps.db)))(ctx).catch(() => null)),
  };
}

const sum = (pts: WeekPoint[]): number | null => (pts.length && pts.every((p) => p.signups !== null) ? pts.reduce((n, p) => n + (p.signups ?? 0), 0) : null);

function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export interface Filled {
  block: MetricBlock;
  /** What the slide still needs when there was no number: the Needs callout's words. */
  need: string | null;
  warning?: string;
}

/** Fill one server block from the brand's own data, as of the reader's moment. */
export async function fillBlock(reader: MetricReader, req: BlockRequest): Promise<Filled> {
  const now = reader.now;
  const asOf = now.toISOString();
  const id = req.id ?? newId("mb");
  const base = { id, meaning: req.meaning, grain: req.grain, asOf } as const;

  if (req.meaning === "waitlistSignups" || req.meaning === "signupGrowth") {
    const weeks = req.weeks ?? 12;
    const pts = (await reader.weekly()).slice(-weeks);
    const periodWords = periodWordsFor(weeks, asOf, now);
    if (req.meaning === "waitlistSignups") {
      const total = pts.length === weeks ? sum(pts) : null;
      const value = total && total > 0 ? total : null;
      const block: MetricBlock = compact({
        ...base,
        weeks,
        name: req.grain === "week" ? BLOCK_NAME.waitlistWeekly : BLOCK_NAME.waitlistSignups,
        value,
        unit: "count" as const,
        series: value !== null && req.grain === "week" ? pts.map((p) => ({ label: dayWords(p.start, now), start: p.start, value: p.signups ?? 0 })) : undefined,
        display: value === null ? "" : formatValue({ value, unit: "count" }),
        periodWords,
        source: { kind: "insights" as const },
      });
      return { block, need: value === null ? MISSING_WORDS.demand : null };
    }
    const half = Math.floor(weeks / 2);
    const first = pts.length === weeks ? sum(pts.slice(0, half)) : null;
    const second = pts.length === weeks ? sum(pts.slice(half)) : null;
    const value = first && second !== null ? Math.round(((second - first) / first) * 100) : null;
    const block: MetricBlock = compact({
      ...base,
      grain: "total" as const,
      weeks,
      name: BLOCK_NAME.signupGrowth,
      value,
      unit: "percent" as const,
      display: value === null ? "" : formatValue({ value, unit: "percent" }),
      periodWords,
      source: { kind: "insights" as const },
    });
    return { block, need: value === null ? MISSING_WORDS.demand : null };
  }

  // launchSignups: one launch's people, only with the one People list.
  const launches = await reader.launches();
  const launch = launches?.find((l) => l.id === req.launchId) ?? null;
  const value = launch && launch.count > 0 ? launch.count : null;
  const block: MetricBlock = compact({
    ...base,
    grain: "total" as const,
    launchId: req.launchId ? req.launchId.slice(0, 64) : undefined,
    name: launch ? BLOCK_NAME.launchSignups(launch.name).slice(0, 80) : BLOCK_NAME.launchSignups("a launch"),
    value,
    unit: "count" as const,
    display: value === null ? "" : formatValue({ value, unit: "count" }),
    source: { kind: "audience" as const },
  });
  const warning = launches === null ? "People on a launch needs the one People list, which is off here." : !launch ? "That launch wasn't found." : undefined;
  return { block, need: value === null ? MISSING_WORDS.demand : null, ...(warning ? { warning } : {}) };
}

/** What a server block asked for, to fill it again. */
export function requestOf(b: MetricBlock): BlockRequest | null {
  if (b.meaning === "typed") return null;
  return compact({ id: b.id, meaning: b.meaning, grain: b.grain === "week" ? "week" : "total", weeks: b.weeks, launchId: b.launchId }) as BlockRequest;
}

/** Whether a stored block is the one this request asks for (so a save keeps its frozen value). */
export function sameRequest(b: MetricBlock, req: BlockRequest): boolean {
  if (b.meaning !== req.meaning) return false;
  const grain = b.grain === "week" ? "week" : "total";
  const weeks = (m: ServerMeaning, w?: number) => (m === "launchSignups" ? undefined : (w ?? 12));
  return grain === req.grain && weeks(b.meaning, b.weeks) === weeks(req.meaning, req.weeks) && (b.launchId ?? "") === (req.launchId ?? "");
}

/** A number a person typed, or said in chat (`saidInChat`, with their words in `quote`). */
export interface TypedInput {
  id?: string;
  name: string;
  value: number;
  unit: MetricBlock["unit"];
  currency?: MetricBlock["currency"];
  per?: "month" | "year" | null;
  series?: Array<{ label: string; value: number }>;
  grain?: "week" | "month";
  from?: string;
}

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const bounded = (v: number) => Math.max(-L.maxValue, Math.min(L.maxValue, v));

export function typedBlock(
  input: TypedInput,
  by: { typedBy: string; saidInChat?: boolean; quote?: string },
  now: Date,
): MetricBlock {
  const series = (input.series ?? []).slice(0, L.series).map((p) => ({ label: clip(p.label, 24), value: bounded(p.value) }));
  const value = bounded(input.value);
  const currency = input.unit === "money" ? (input.currency ?? "GBP") : undefined;
  const per = input.per ?? null;
  const from = clip(input.from, L.typedFrom);
  return compact({
    id: input.id ?? newId("mb"),
    meaning: "typed" as const,
    grain: series.length ? (input.grain ?? "month") : ("total" as const),
    name: clip(input.name, L.typedName) || "Number",
    value,
    unit: input.unit,
    currency,
    per,
    series: series.length ? series : undefined,
    display: formatValue({ value, unit: input.unit, currency, per }),
    source: compact({
      kind: "typed" as const,
      from: from || undefined,
      typedBy: by.typedBy.slice(0, 128),
      saidInChat: by.saidInChat ? true : undefined,
      quote: by.quote ? clip(by.quote, L.quote) : undefined,
    }),
    asOf: now.toISOString(),
  });
}

/** Whether a typed block says the same as this input (so a save keeps its stamps). */
export function sameTyped(b: MetricBlock, input: TypedInput): boolean {
  if (b.meaning !== "typed") return false;
  const series = (input.series ?? []).map((p) => `${clip(p.label, 24)}=${p.value}`).join("|");
  const stored = (b.series ?? []).map((p) => `${p.label}=${p.value}`).join("|");
  return (
    b.name === (clip(input.name, L.typedName) || "Number") &&
    b.value === input.value &&
    b.unit === input.unit &&
    (b.currency ?? null) === (input.unit === "money" ? (input.currency ?? "GBP") : null) &&
    (b.per ?? null) === (input.per ?? null) &&
    (b.source.from ?? "") === clip(input.from, L.typedFrom) &&
    stored === series
  );
}

/** What the Insert a number dialog and the prompt may offer: which meanings have data, never their values. */
export interface NumberOptions {
  waitlist: { weeks: number; hasData: boolean };
  growth: { hasData: boolean };
  /** Launches with people on them; null while the one People list is off. */
  launches: Array<{ id: string; name: string }> | null;
}

export async function numberOptions(reader: MetricReader): Promise<NumberOptions> {
  const pts = (await reader.weekly()).slice(-12);
  const total = pts.length === 12 ? sum(pts) : null;
  const first = pts.length === 12 ? sum(pts.slice(0, 6)) : null;
  const launches = await reader.launches();
  return {
    waitlist: { weeks: 12, hasData: Boolean(total && total > 0) },
    growth: { hasData: Boolean(first && first > 0) },
    launches: launches ? launches.filter((l) => l.count > 0).map((l) => ({ id: l.id, name: l.name })) : null,
  };
}

export interface NumberChange {
  slideN: number;
  name: string;
  from: string;
  to: string;
}

/**
 * Every server block filled again as of now. Typed blocks are left as they are. `changed` lists the
 * blocks whose figure moved; with none, the caller saves no new version.
 */
export async function refreshBlocks(reader: MetricReader, slides: readonly Slide[]): Promise<{ slides: Slide[]; changed: NumberChange[] }> {
  const changed: NumberChange[] = [];
  const out: Slide[] = [];
  for (const [i, s] of slides.entries()) {
    const blocks: MetricBlock[] = [];
    for (const b of s.blocks) {
      const req = requestOf(b);
      if (!req) {
        blocks.push(b);
        continue;
      }
      const { block } = await fillBlock(reader, req);
      const same = block.value === b.value && block.display === b.display && JSON.stringify(block.series ?? []) === JSON.stringify(b.series ?? []);
      if (same) blocks.push(b);
      else {
        blocks.push(block);
        changed.push({ slideN: i + 1, name: b.meaning === "launchSignups" ? BLOCK_SHORT.launchSignups : BLOCK_SHORT[b.meaning], from: b.display || "none", to: block.display || "none" });
      }
    }
    out.push({ ...s, blocks });
  }
  return { slides: out, changed };
}
