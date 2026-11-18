import { createHash } from "node:crypto";
import { textKey } from "@/lib/content/blog/brief";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandSignal, SerpFindings, SerpJudgement, SerpNumbers, SignalMarket } from "@/lib/types/brandSignal";

/**
 * The signals store (BRAND_SIGNALS_ENABLED): `brand_signals`, one record per question and market.
 * Every query is an equality on one field (beside the brand), so none needs a composite index.
 */

export interface SignalStoreDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

/** A ready lookup is used again, without paying, for this long. */
export const FRESH_MS = 90 * 24 * 60 * 60 * 1000;
/** A task DataForSEO hasn't finished by then is given up. */
export const GIVE_UP_MS = 30 * 60 * 1000;
/** How long one collect may hold a record before another run may take it. */
export const SIGNAL_LEASE_MS = 60_000;
/** Waited before the first collect: DataForSEO needs a few seconds at least. */
export const FIRST_LOOK_MS = 15_000;

const repoOf = (ctx: TenantContext, deps: SignalStoreDeps) => forTenant(ctx, deps.db).brandSignals;
const nowOf = (deps: SignalStoreDeps) => (deps.now ?? (() => new Date()))();

/** "2026-11": the month a lookup counts against. */
export const monthOf = (d: Date) => d.toISOString().slice(0, 7);

/** The words a lookup is keyed on: case, spacing and punctuation don't make a new lookup. */
export const queryKey = (query: string) => textKey(query);

/** One record per brand, question wording and market. */
export function signalIdFor(tenantId: string, query: string, market: SignalMarket): string {
  const key = `${tenantId}\nserp\n${queryKey(query)}\n${market.country.toUpperCase()}\n${market.language}`;
  return `sig_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

/** The stored lookup for a question in a market, whatever its state. */
export async function signalFor(ctx: TenantContext, query: string, market: SignalMarket, deps: SignalStoreDeps = {}): Promise<BrandSignal | null> {
  return repoOf(ctx, deps).getById(signalIdFor(ctx.tenantId, query, market));
}

export async function getSignal(ctx: TenantContext, id: string, deps: SignalStoreDeps = {}): Promise<BrandSignal | null> {
  return repoOf(ctx, deps).getById(id);
}

/** Whether a stored lookup can be used again without asking DataForSEO. */
export function isFresh(s: BrandSignal | null, now: Date): boolean {
  return Boolean(s && s.status === "ready" && s.readyAt && now.getTime() - Date.parse(s.readyAt) < FRESH_MS);
}

/** Whether a lookup is still on its way (posted, not given up). */
export function isPending(s: BrandSignal | null, now: Date): boolean {
  return Boolean(s && s.status === "posted" && now.getTime() - Date.parse(s.postedAt) < GIVE_UP_MS);
}

export interface PostedLookup {
  query: string;
  questionId: string | null;
  subjectId: string | null;
  market: SignalMarket;
  askedBy: BrandSignal["askedBy"];
  taskId: string;
  cost: number | null;
}

/**
 * Keep a task DataForSEO took. A lookup of the same question and market starts afresh in the
 * same record: what was found before is cleared, so nothing old is read as new.
 */
export async function recordPosted(ctx: TenantContext, p: PostedLookup, deps: SignalStoreDeps = {}): Promise<BrandSignal> {
  const now = nowOf(deps);
  const at = now.toISOString();
  const fields = {
    source: "dataforseo" as const,
    about: { query: p.query.trim().slice(0, 300), questionId: p.questionId, subjectId: p.subjectId },
    market: { country: p.market.country.toUpperCase(), language: p.market.language },
    status: "posted" as const,
    taskId: p.taskId,
    askedBy: p.askedBy,
    postedAt: at,
    dueAt: new Date(now.getTime() + FIRST_LOOK_MS).toISOString(),
    readyAt: null,
    lookupMonth: monthOf(now),
    cost: p.cost,
    numbers: null,
    results: null,
    judged: null,
    error: null,
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    updatedAt: at,
  };
  const id = signalIdFor(ctx.tenantId, p.query, p.market);
  const { doc } = await repoOf(ctx, deps).upsert(
    id,
    () => ({ ...fields, createdAt: at }),
    () => fields,
  );
  return doc;
}

/** Lookups the brand made this calendar month, against its cap (src/lib/plans/limits.ts). */
export async function lookupsThisMonth(ctx: TenantContext, deps: SignalStoreDeps = {}): Promise<number> {
  return repoOf(ctx, deps).count([["lookupMonth", "==", monthOf(nowOf(deps))]]);
}

/** Lookups waiting to be collected now: posted, due, and not held by another run. */
export async function dueSignals(ctx: TenantContext, limit: number, deps: SignalStoreDeps = {}): Promise<BrandSignal[]> {
  const nowMs = nowOf(deps).getTime();
  const posted = await repoOf(ctx, deps).find({ where: [["status", "==", "posted"]], limit: 100 });
  return posted
    .filter((s) => Date.parse(s.dueAt) <= nowMs && (!s.leaseUntil || Date.parse(s.leaseUntil) <= nowMs))
    .sort((a, b) => (a.askedBy === b.askedBy ? a.dueAt.localeCompare(b.dueAt) : a.askedBy === "person" ? -1 : 1))
    .slice(0, limit);
}

/** Take a lookup to collect. Null when another run has it, or it's no longer waiting. */
export async function claimSignal(ctx: TenantContext, id: string, leaseId: string, deps: SignalStoreDeps = {}): Promise<BrandSignal | null> {
  const nowMs = nowOf(deps).getTime();
  return repoOf(ctx, deps).claim(id, (cur) => {
    const free = cur.status === "posted" && (!cur.leaseUntil || Date.parse(cur.leaseUntil) <= nowMs);
    return free ? { leaseId, leaseUntil: new Date(nowMs + SIGNAL_LEASE_MS).toISOString(), attempts: cur.attempts + 1 } : null;
  });
}

export type SignalOutcome =
  | { status: "ready"; numbers: SerpNumbers; results: SerpFindings; cost: number | null }
  | { status: "failed"; error: string }
  | { status: "not_yet"; nextLookMs: number };

/** Save what a collect found, only if this run still holds the lease. */
export async function finishSignal(
  ctx: TenantContext,
  id: string,
  leaseId: string,
  outcome: SignalOutcome,
  deps: SignalStoreDeps = {},
): Promise<BrandSignal | null> {
  const now = nowOf(deps);
  const at = now.toISOString();
  return repoOf(ctx, deps).claim(id, (cur) => {
    if (cur.leaseId !== leaseId || cur.status !== "posted") return null;
    const release = { leaseId: null, leaseUntil: null, updatedAt: at };
    if (outcome.status === "ready") {
      return { ...release, status: "ready", readyAt: at, numbers: outcome.numbers, results: outcome.results, cost: outcome.cost ?? cur.cost, error: null };
    }
    if (outcome.status === "failed") return { ...release, status: "failed", error: outcome.error.slice(0, 80) };
    // Not ready yet: look again later, unless it has waited too long.
    if (now.getTime() - Date.parse(cur.postedAt) >= GIVE_UP_MS) return { ...release, status: "failed", error: "not_ready_in_time" };
    return { ...release, dueAt: new Date(now.getTime() + outcome.nextLookMs).toISOString() };
  });
}

/** Ready lookups, newest first (for brand search and the context pack). */
export async function readySignals(ctx: TenantContext, limit: number, deps: SignalStoreDeps = {}): Promise<BrandSignal[]> {
  const rows = await repoOf(ctx, deps).find({ where: [["status", "==", "ready"]], limit: Math.min(limit, 1000) });
  return rows.sort((a, b) => (b.readyAt ?? "").localeCompare(a.readyAt ?? ""));
}

/** Keep the judge's verdicts on a ready lookup, unless a newer judge already gave them. */
export async function saveJudgement(ctx: TenantContext, id: string, judged: SerpJudgement, deps: SignalStoreDeps = {}): Promise<BrandSignal | null> {
  return repoOf(ctx, deps).claim(id, (cur) =>
    cur.status === "ready" && !(cur.judged && cur.judged.version >= judged.version) ? { judged, updatedAt: nowOf(deps).toISOString() } : null,
  );
}
