import { fold } from "@/lib/brandMap/changes";
import { dayWords } from "@/lib/connectors/period";
import type { CoverageFlag } from "@/lib/competitors/coverage";
import { competitorProfiles } from "@/lib/competitors/profile";
import type { Competitor, CompetitorArticle } from "@/lib/types/competitor";
import {
  BRAND_STRATEGY_LIMITS as L,
  STRATEGY_CHECK_LIMITS as C,
  StrategyCheckSchema,
  type CheckFocus,
  type CheckReason,
  type StrategyCheck,
} from "@/lib/types/brandStrategy";

/**
 * The weekly strategy check's rules (STRATEGY_CHECK_ENABLED), by code, with no model call. Pure and
 * client safe: check.ts reads the data and keeps the result on the strategy record.
 *
 * A look sets the approved strategy's focus situations against what the watched competitors
 * published, and asks for a person's look only when something material changed:
 *  - 3 or more of their articles on one focus situation, published since the check's `since` (the
 *    later of approval, a dismissal, or a row that closed itself), by publish date only: an article
 *    with no publish date might be old, so it never counts as new;
 *  - a focus situation newly a gap: they write on it, and no live article of the brand's answers it;
 *  - an alternative on the brand map they name in 3 or more articles that the brand doesn't watch,
 *    raised once.
 *
 * At most one row is open. While it is, each look works its reasons out again from the same
 * starting point; when none are left, it closes itself. Dismiss keeps it quiet 30 days, and the
 * starting point moves to that day.
 */

const DAY_MS = 86_400_000;

export interface LookInput {
  /** The approved strategy's focus situations, in its order. */
  focusIds: string[];
  /** The brand's decided buying situations, with their questions and how many a live article answers. */
  situations: Array<{ id: string; text: string; questions: number; answered: number }>;
  articles: CompetitorArticle[];
  competitors: Array<Pick<Competitor, "id" | "name">>;
  alternatives: Array<{ name: string; aliases: string[] }>;
  nowMs: number;
}

export interface Look {
  focus: CheckFocus[];
  named: Array<{ name: string; count: number }>;
  /** Per focus situation, their new articles by competitor (most first). */
  newBy: Map<string, Array<{ name: string; count: number }>>;
}

/** One line of text, at most `n` characters, cut at a word. */
export function clipText(s: string, n: number = C.text): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= n) return one;
  const cut = one.slice(0, n - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > n / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

const byCount = (a: { name: string; count: number }, b: { name: string; count: number }) => b.count - a.count || a.name.localeCompare(b.name);

/** What the check sees now, counting new articles from `since` (a day). Pure. */
export function lookNow(input: LookInput, since: string): Look {
  const focusSits = input.focusIds.flatMap((id) => input.situations.filter((s) => s.id === id));
  const view = competitorProfiles({ articles: input.articles, competitors: input.competitors, situations: focusSits, alternatives: input.alternatives, nowMs: input.nowMs, since: null });
  const names = new Map(input.competitors.map((c) => [c.id, c.name] as const));
  const fresh = input.articles.filter((a) => a.status === "read" && names.has(a.competitorId) && Boolean(a.publishedAt) && a.publishedAt!.slice(0, 10) >= since);
  const newBy = new Map<string, Array<{ name: string; count: number }>>();
  for (const s of focusSits) {
    const counts = new Map<string, number>();
    for (const a of fresh) if (a.situationIds.includes(s.id)) counts.set(a.competitorId, (counts.get(a.competitorId) ?? 0) + 1);
    newBy.set(s.id, [...counts].map(([id, count]) => ({ name: clipText(names.get(id) ?? "", L.competitorName), count })).filter((b) => b.name).sort(byCount));
  }
  const focus = view.situations.map(
    (s): CheckFocus => ({
      id: s.id,
      text: clipText(s.text),
      they: s.they,
      newSince: (newBy.get(s.id) ?? []).reduce((n, b) => n + b.count, 0),
      by: s.byCompetitor.filter((b) => b.name).slice(0, C.by).map((b) => ({ name: clipText(b.name, L.competitorName), count: b.count })),
      questions: s.questions,
      answered: s.answered,
      flag: s.flag,
    }),
  );
  return { focus, named: view.namedNotWatched.slice(0, C.named).map((n) => ({ name: clipText(n.name, L.competitorName), count: n.count })), newBy };
}

const gapsOf = (focus: CheckFocus[]) => focus.filter((f) => f.flag === "gap").map((f) => f.id);

/** The reasons to ask for a look, from what the check sees now and where it counts from. Pure. */
export function materialReasons(look: Look, from: Pick<StrategyCheck, "gapIds" | "raisedNames">): CheckReason[] {
  const raised = new Set(from.raisedNames.map(fold));
  const newArticles = look.focus
    .filter((f) => f.newSince >= C.newArticles)
    .sort((a, b) => b.newSince - a.newSince || a.text.localeCompare(b.text))
    .map((f): CheckReason => ({ kind: "new_articles", ref: f.id, text: f.text, count: f.newSince, by: (look.newBy.get(f.id) ?? []).slice(0, C.by) }));
  const newGaps = from.gapIds === null ? [] : look.focus.filter((f) => f.flag === "gap" && !from.gapIds!.includes(f.id)).map((f): CheckReason => ({ kind: "new_gap", ref: f.id, text: f.text, count: f.they, by: f.by }));
  const named = look.named.filter((n) => n.count >= C.namedArticles && !raised.has(fold(n.name))).map((n): CheckReason => ({ kind: "named", ref: n.name, text: n.name, count: n.count, by: [] }));
  return [...newArticles, ...newGaps, ...named].slice(0, C.reasons);
}

/** A short key for a set of reasons: it changes when what they are about does, not with their counts. */
export function reasonsKey(reasons: CheckReason[]): string {
  let h = 5381;
  for (const ch of reasons.map((r) => `${r.kind}:${fold(r.ref)}`).join("|")) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return `chk_${h.toString(36)}`;
}

const plusDays = (nowIso: string, days: number) => new Date(Date.parse(nowIso) + days * DAY_MS).toISOString();

/** Alternatives raised once, newest first: kept so they aren't raised again. */
function withRaised(before: string[], added: string[]): string[] {
  const out: string[] = [];
  for (const n of [...added, ...before]) if (!out.some((o) => fold(o) === fold(n))) out.push(n);
  return out.slice(0, C.raisedNames);
}

/** The check as approving leaves it: due at the next check tick, counting from the approval's day. */
export function freshCheck(approvedAt: string, prev: Pick<StrategyCheck, "raisedNames"> | null): StrategyCheck {
  return StrategyCheckSchema.parse({ since: approvedAt.slice(0, 10), raisedNames: prev?.raisedNames ?? [] });
}

/** Where counting starts again: today, with the gaps and names seen now as the ones already known. */
function movedOn(check: StrategyCheck, today: string, names: string[]): Pick<StrategyCheck, "since" | "gapIds" | "raisedNames"> {
  return { since: today, gapIds: gapsOf(check.focus), raisedNames: withRaised(check.raisedNames, names) };
}

/**
 * The check after a look at `nowIso`. `prev` is the check as stored now (null before its first
 * look), `approvedAt` when the approved strategy was approved. Pure.
 */
export function nextCheck(prev: StrategyCheck | null, approvedAt: string, input: LookInput, nowIso: string): StrategyCheck {
  const base = prev ?? freshCheck(approvedAt, null);
  const nowMs = Date.parse(nowIso);
  const quiet = Boolean(base.dismissedUntil && Date.parse(base.dismissedUntil) > nowMs);
  const look = lookNow(input, base.since);
  const seen: StrategyCheck = { ...base, lookedAt: nowIso, nextAt: plusDays(nowIso, C.everyDays), focus: look.focus, named: look.named, dismissedUntil: quiet ? base.dismissedUntil : null };
  // Dismissed: the numbers stay current for Vizzy, and nothing is raised or moved on.
  if (quiet) return seen;
  const reasons = materialReasons(look, base);
  if (base.open) {
    if (reasons.length) return { ...seen, open: { ...base.open, key: reasonsKey(reasons), reasons } };
    // Nothing material is left: the row closes itself, and counting starts again today.
    return { ...seen, open: null, ...movedOn(seen, nowIso.slice(0, 10), base.open.reasons.filter((r) => r.kind === "named").map((r) => r.ref)) };
  }
  if (reasons.length) return { ...seen, open: { key: reasonsKey(reasons), raisedAt: nowIso, reasons, actedAt: null } };
  // A quiet look: the gaps it saw are the ones the next look compares with.
  return { ...seen, gapIds: gapsOf(look.focus) };
}

/** The check after an admin dismisses its row: quiet 30 days, counting again from today. Pure. */
export function dismissedCheck(check: StrategyCheck, nowIso: string): StrategyCheck {
  const named = [...(check.open?.reasons ?? []).filter((r) => r.kind === "named").map((r) => r.ref), ...check.named.filter((n) => n.count >= C.namedArticles).map((n) => n.name)];
  return { ...check, open: null, dismissedUntil: plusDays(nowIso, C.dismissDays), ...movedOn(check, nowIso.slice(0, 10), named) };
}

/** Whether the check is due a look at `nowMs`. */
export function checkDue(check: Pick<StrategyCheck, "nextAt"> | null, nowMs: number): boolean {
  return !check?.nextAt || !(Date.parse(check.nextAt) > nowMs);
}

/** A situation's words inside quotes: no closing full stop. */
const quoted = (text: string) => `"${clipText(text, 80).replace(/[.!?]+$/, "")}"`;

/** "2 Dec", with the year when it isn't this year's. */
function sinceWords(since: string, nowIso: string): string {
  return dayWords(since, since.slice(0, 4) !== nowIso.slice(0, 4));
}

/** One reason as Review says it. */
export function reasonLine(r: CheckReason, since: string, nowIso: string): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (r.kind === "new_articles") {
    const day = sinceWords(since, nowIso);
    if (r.by.length === 1) return `${r.by[0]!.name} wrote ${n(r.count, "new article", "new articles")} on ${quoted(r.text)} since ${day}.`;
    return `Your competitors wrote ${n(r.count, "new article", "new articles")} on ${quoted(r.text)} since ${day}: ${r.by.map((b) => `${b.name} ${b.count}`).join(", ")}.`;
  }
  if (r.kind === "new_gap") return `${quoted(r.text)} is now a gap: your competitors write on it, and no live article of yours answers it yet.`;
  return `Your competitors name ${r.text} in ${n(r.count, "article", "articles")}, and you don't watch it.`;
}

/** The words for a coverage label, as the coverage page says them. */
export const FLAG_WORDS: Record<CoverageFlag, string> = {
  gap: "gap: they write about it, you don't yet",
  open: "open: nobody writes about it",
  crowded: "crowded: a new angle stands out",
  you_lead: "you lead",
  even: "even",
};
