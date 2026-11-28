import type { MeaningKey } from "@/lib/metrics/meanings";
import { OUTCOME_KINDS, type KindCoverage, type OutcomeKind } from "@/lib/metrics/outcomes";
import {
  MONTH_REST_ID,
  NOT_NOW_LABEL,
  STRATEGY_SUGGEST_LIMITS as S,
  StrategySuggestionSchema,
  type MonthNumbers,
  type MonthRow,
  type NotNowReason,
  type Strategy,
  type StrategyMonth,
  type StrategySuggestion,
  type SuggestBuiltIn,
  type SuggestDetail,
  type SuggestHold,
  type SuggestionKind,
} from "@/lib/types/brandStrategy";
import { arrowFor, monthBefore, monthCounts, type MonthInput, type MonthRecord } from "./monthRules";

/**
 * One suggestion a month (STRATEGY_SUGGEST_ENABLED), by rules, with no model call. Pure and client
 * safe: month.ts calls it when the monthly look keeps a month, Review, the Strategy tab and Vizzy
 * read what it kept. It never changes a strategy or a plan (decision 9): a person decides.
 *
 * Each rule says which kinds of result it needs and is skipped when none of them is measured. The
 * first that applies is the month's suggestion, and only one is kept:
 *  1. behind_plan (built in): 3 or more of the approved plan's entries to write were due by the end
 *     of the month and no live article answers them. It names up to 3.
 *  2. stalled_focus (needs search, visits or AI answers): a focus situation with no new live article
 *     and no result in each of the last 2 kept months, judged only on kinds with the same source in
 *     both (the rule How it went's arrows use), while the rest of the map moved (a new live article,
 *     or a result that rose). It suggests a swap: the situation outside the focus their articles of
 *     the last 90 days are most on, when the brand reads them; else the one whose live articles had
 *     the most of a result measured by page this month; else the one with the most questions no
 *     live article answers. A step whose best is 0 falls to the next; with none, it doesn't apply.
 *  3. claim_no_proof (built in): a claim of the approved strategy where you win that had no proof in
 *     each of the 2 newest kept months.
 *  4. measure_more: a kind not connected or not shared (never one whose read failed), the first in
 *     OUTCOME_KINDS order, with the connectors in this build that give it.
 *  5. working: the focus situations' result rose against last month by more than the rest of the
 *     map's. It only adds a line to How it went; it never makes a Review row.
 * Not now keeps a suggestion (its kind and what it is about) away 60 days, or 90 for measure_more;
 * a held one is skipped and the next that applies is used.
 */

const DAY_MS = 86_400_000;

/**
 * One line of text, at most `n` characters, cut at a word (as checkRules.ts clipText, kept here so
 * this file stays client safe: checkRules reads the competitors' coverage, which is server only).
 */
function clipText(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= n) return one;
  const cut = one.slice(0, n - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > n / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "")}…`;
}
/** Their articles of this many days count toward a swap. */
const THEIRS_DAYS = 90;

/** The kinds a stalled focus can be judged on: each says whether anyone finds or reads its articles. */
const STALL_KINDS: readonly OutcomeKind[] = ["search", "visits", "ai_answers"];

/** Every number a row keeps for a kind, by meaning: the first is the one shown. */
const MEASURE_OF: Record<OutcomeKind, keyof MonthNumbers> = { search: "searchClicks", visits: "ga4Sessions", key_actions: "ga4KeyEvents", ai_answers: "aiCitations" };

export interface SuggestInput {
  nowIso: string;
  /** The months that count, newest first: the one just kept first. */
  months: readonly StrategyMonth[];
  approved: Pick<Strategy, "at" | "focusSituationIds" | "claims" | "goal">;
  /** The approved strategies before it, newest first: how long a claim has gone without proof. */
  history: ReadonlyArray<Pick<Strategy, "at" | "claims">>;
  /** The approved plan's stamp, and its entries to write due by the end of the month that no live article answers, earliest first. */
  plan: { at: string; behind: ReadonlyArray<{ slotId: string; title: string }> } | null;
  /** The brand's decided buying situations, with their words now. */
  situations: ReadonlyArray<{ id: string; text: string; questions: number; answered: number }>;
  /** Their articles (watched, read), or null when the brand doesn't read them. */
  theirs: ReadonlyArray<{ publishedAt: string | null; situationIds: readonly string[] }> | null;
  /** The live articles the look read, each with the situation it was written for. */
  articles: ReadonlyArray<{ key: string; situationId: string | null }>;
  /** Each article page's numbers, by meaning, from the look's reads. */
  byPage: Readonly<Record<string, Partial<Record<MeaningKey, number>>>>;
  /** What each kind could be measured from at the look. */
  coverage: readonly KindCoverage[];
  /** Holds as stored: expired ones count for nothing. */
  holds: readonly SuggestHold[];
}

type Candidate = { about: string; detail: SuggestDetail; builtIn: SuggestBuiltIn[]; measured: OutcomeKind[] };

const rowOf = (m: StrategyMonth, id: string): MonthRow | undefined => m.rows.find((r) => r.id === id);
/** The number a month shows for a kind, by its source's own meaning. */
const measureIn = (m: StrategyMonth, kind: OutcomeKind) => (m.sources[kind]?.measure ?? MEASURE_OF[kind]) as keyof MonthNumbers;
const valueOf = (m: StrategyMonth, r: MonthRow | undefined, kind: OutcomeKind): number => r?.m[measureIn(m, kind)] ?? 0;
const focusRows = (m: StrategyMonth) => m.rows.filter((r) => r.id !== MONTH_REST_ID);

/** Kinds measured by page with the same source in both months (the arrows' rule). Pure. */
export function sameSourceKinds(now: StrategyMonth, before: StrategyMonth | null, kinds: readonly OutcomeKind[] = OUTCOME_KINDS): OutcomeKind[] {
  if (!before) return [];
  return kinds.filter((k) => arrowFor(now, before, MONTH_REST_ID, k) !== null);
}

/** A short key for a suggestion: it changes with its kind and what it is about, not its numbers. */
export function suggestionKey(kind: SuggestionKind, about: string): string {
  let h = 5381;
  for (const ch of `${kind}:${about}`) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return `sug_${h.toString(36)}`;
}

/** Whether a hold keeps that kind of suggestion about that thing away at `nowIso`. */
export function isHeld(holds: readonly SuggestHold[], kind: SuggestionKind, about: string, nowIso: string): boolean {
  return holds.some((h) => h.kind === kind && h.about === about && h.until > nowIso);
}

/** Holds still in force, newest first, 20 at most. Pure. */
export function liveHolds(holds: readonly SuggestHold[], nowIso: string): SuggestHold[] {
  return holds.filter((h) => h.until > nowIso).slice(0, S.holds);
}

/** The holds after Not now: this one first, an older one for the same thing replaced. Pure. */
export function withHold(holds: readonly SuggestHold[], s: Pick<StrategySuggestion, "about" | "detail">, reason: NotNowReason, nowIso: string): SuggestHold[] {
  const days = s.detail.kind === "measure_more" ? S.measureHoldDays : S.holdDays;
  const hold: SuggestHold = { kind: s.detail.kind, about: s.about, until: new Date(Date.parse(nowIso) + days * DAY_MS).toISOString(), reason };
  return [hold, ...liveHolds(holds, nowIso).filter((h) => !(h.kind === hold.kind && h.about === hold.about))].slice(0, S.holds);
}

/**
 * Whether a suggestion is one Propose takes as a note, and approving a draft proposed with it acts on
 * it: open in Review, and not Measure more, which only connecting a tool (or Not now) settles.
 */
export const isNoteSuggestion = (s: StrategySuggestion | null | undefined): s is StrategySuggestion => isReviewSuggestion(s) && s.detail.kind !== "measure_more";

/**
 * Words people use for key actions, in their goal's measure, each with its singular: the brand's own
 * word is used in a suggestion's words ("1 enquiry", "6 enquiries").
 */
const KEY_ACTION_WORDS: Readonly<Record<string, string>> = {
  bookings: "booking",
  appointments: "appointment",
  "sign-ups": "sign-up",
  registrations: "registration",
  enquiries: "enquiry",
  inquiries: "inquiry",
  leads: "lead",
  orders: "order",
  purchases: "purchase",
  sales: "sale",
  trials: "trial",
  demos: "demo",
  subscribers: "subscriber",
  subscriptions: "subscription",
  donations: "donation",
  members: "member",
  customers: "customer",
};

/** The brand's word for key actions, when its goal's measure names one ("bookings from the site"): else null. Pure. */
export function keyActionWord(measure: string | null | undefined): string | null {
  const words = (measure ?? "").toLowerCase().replace(/\bsign[- ]?ups?\b/g, "sign-ups");
  return Object.keys(KEY_ACTION_WORDS).find((w) => new RegExp(`(^|[^a-z-])${w}([^a-z-]|$)`).test(words)) ?? null;
}

// ----- The rules ---------------------------------------------------------------------------------

function behindPlan(input: SuggestInput): Candidate[] {
  const plan = input.plan;
  if (!plan || plan.behind.length < S.behind) return [];
  // Only entries with words can be named: a suggestion that names none says nothing to write.
  const entries = plan.behind.map((e) => ({ slotId: e.slotId, title: clipText(e.title, 120) })).filter((e) => e.title).slice(0, S.named);
  if (!entries.length) return [];
  return [{ about: `plan:${plan.at}`.slice(0, 64), detail: { kind: "behind_plan", behind: plan.behind.length, entries }, builtIn: ["articles", "roadmap"], measured: [] }];
}

/** The situation outside the focus to swap a stalled one for, and what picked it. */
function swapFor(input: SuggestInput, now: StrategyMonth): { swap: Extract<SuggestDetail, { kind: "stalled_focus" }>["swap"]; builtIn: SuggestBuiltIn[]; measured: OutcomeKind[] } | null {
  const focus = new Set(input.approved.focusSituationIds);
  const outside = input.situations.filter((s) => !focus.has(s.id));
  if (!outside.length) return null;
  const best = (score: (s: (typeof outside)[number]) => number) => {
    let top: { s: (typeof outside)[number]; n: number } | null = null;
    for (const s of outside) {
      const n = score(s);
      if (n > 0 && (!top || n > top.n)) top = { s, n };
    }
    return top;
  };
  const swap = (s: (typeof outside)[number], by: "their_articles" | "result" | "questions", count: number, outcome: OutcomeKind | null = null) => ({
    id: s.id,
    text: clipText(s.text, 120),
    by,
    count,
    outcome,
    measure: outcome ? measureIn(now, outcome) : null,
  });
  // 1. Their articles of the last 90 days, when the brand reads them.
  if (input.theirs) {
    const from = new Date(Date.parse(input.nowIso) - THEIRS_DAYS * DAY_MS).toISOString().slice(0, 10);
    const recent = input.theirs.filter((t) => t.publishedAt && t.publishedAt.slice(0, 10) >= from);
    const top = best((s) => recent.filter((t) => t.situationIds.includes(s.id)).length);
    if (top) return { swap: swap(top.s, "their_articles", top.n), builtIn: ["their_articles"], measured: [] };
  }
  // 2. The first result measured by page this month, over the live articles written for each situation.
  const kind = OUTCOME_KINDS.find((k) => now.sources[k] && !now.sources[k]!.siteOnly);
  if (kind) {
    const measure = measureIn(now, kind);
    const top = best((s) => input.articles.filter((a) => a.situationId === s.id).reduce((t, a) => t + (input.byPage[a.key]?.[measure] ?? 0), 0));
    if (top) return { swap: swap(top.s, "result", top.n, kind), builtIn: [], measured: [kind] };
  }
  // 3. Questions no live article answers yet.
  const top = best((s) => Math.max(0, s.questions - s.answered));
  return top ? { swap: swap(top.s, "questions", top.n), builtIn: ["questions"], measured: [] } : null;
}

function stalledFocus(input: SuggestInput): Candidate[] {
  const now = input.months[0];
  const before = now ? monthBefore(input.months, now.month) : null;
  if (!now || !before) return [];
  const kinds = sameSourceKinds(now, before, STALL_KINDS);
  if (!kinds.length) return [];
  const restNow = rowOf(now, MONTH_REST_ID);
  const restBefore = rowOf(before, MONTH_REST_ID);
  const moved = (restNow?.newLive ?? 0) + (restBefore?.newLive ?? 0) > 0 || kinds.some((k) => arrowFor(now, before, MONTH_REST_ID, k) === "up");
  if (!moved) return [];
  const words = new Map(input.situations.map((s) => [s.id, s.text] as const));
  const out: Candidate[] = [];
  for (const id of input.approved.focusSituationIds) {
    const a = rowOf(now, id);
    const b = rowOf(before, id);
    if (!a || !b || a.newLive || b.newLive || kinds.some((k) => valueOf(now, a, k) > 0 || valueOf(before, b, k) > 0)) continue;
    const text = words.get(id);
    const y = text ? swapFor(input, now) : null;
    if (!text || !y) continue;
    out.push({
      about: id,
      detail: { kind: "stalled_focus", id, text: clipText(text, 120), kinds, swap: y.swap },
      builtIn: ["articles", ...y.builtIn],
      measured: [...kinds, ...y.measured.filter((k) => !kinds.includes(k))],
    });
  }
  return out;
}

function claimNoProof(input: SuggestInput): Candidate[] {
  const kept = input.months;
  if (kept.length < S.months) return [];
  const approvals = [input.approved, ...input.history];
  const noProofIn = (m: StrategyMonth, id: string) => {
    const s = approvals.find((x) => x.at === m.strategyAt);
    const c = s?.claims.find((x) => x.id === id);
    return Boolean(c && !c.proof);
  };
  const out: Candidate[] = [];
  for (const c of input.approved.claims) {
    if (c.side !== "you" || c.proof) continue;
    let months = 0;
    while (months < kept.length && noProofIn(kept[months]!, c.id)) months += 1;
    if (months < S.months) continue;
    out.push({ about: c.id, detail: { kind: "claim_no_proof", id: c.id, text: c.text, months }, builtIn: ["claims"], measured: [] });
  }
  return out;
}

function measureMore(input: SuggestInput): Candidate[] {
  const out: Candidate[] = [];
  const measured = input.coverage.flatMap((c) => (c.state === "measured" ? [c.kind] : []));
  for (const c of input.coverage) {
    if (c.state === "not_connected") {
      // Only a connector that counts by page lets the strategy tell situations apart: a whole site total never does.
      const list = c.could.filter((x) => !x.siteOnly).slice(0, 3).map((x) => ({ connectorId: x.connectorId, name: x.name.slice(0, 80), href: x.href }));
      if (!list.length) continue;
      out.push({ about: c.kind, detail: { kind: "measure_more", outcome: c.kind, why: "not_connected", connectors: list }, builtIn: ["connections"], measured });
    } else if (c.state === "not_shared") {
      out.push({
        about: c.kind,
        detail: { kind: "measure_more", outcome: c.kind, why: "not_shared", connectors: [{ connectorId: c.connectorId, name: c.connector.slice(0, 80), href: c.href }] },
        builtIn: ["connections"],
        measured,
      });
    }
  }
  return out;
}

/** Now over before, where 0 to more is the most growth there is and 0 to 0 none. */
const growth = (now: number, before: number) => (before > 0 ? now / before : now > 0 ? Number.POSITIVE_INFINITY : 1);

function working(input: SuggestInput): Candidate[] {
  const now = input.months[0];
  const before = now ? monthBefore(input.months, now.month) : null;
  if (!now || !before) return [];
  for (const k of sameSourceKinds(now, before)) {
    const sum = (m: StrategyMonth) => focusRows(m).reduce((t, r) => t + valueOf(m, r, k), 0);
    const [focusNow, focusBefore] = [sum(now), sum(before)];
    const [restNow, restBefore] = [valueOf(now, rowOf(now, MONTH_REST_ID), k), valueOf(before, rowOf(before, MONTH_REST_ID), k)];
    if (focusNow > focusBefore && growth(focusNow, focusBefore) > growth(restNow, restBefore)) {
      return [{ about: k, detail: { kind: "working", outcome: k, measure: measureIn(now, k), focusNow, focusBefore, restNow, restBefore }, builtIn: ["articles"], measured: [k] }];
    }
  }
  return [];
}

const RULES: ReadonlyArray<(input: SuggestInput) => Candidate[]> = [behindPlan, stalledFocus, claimNoProof, measureMore, working];

/**
 * The month's suggestion, or null when no rule applies (or each that does is held). The first rule
 * that applies, and its first thing not held. Pure.
 */
export function pickSuggestion(input: SuggestInput): StrategySuggestion | null {
  const now = input.months[0];
  if (!now) return null;
  const connectorOf = (k: OutcomeKind) => now.sources[k]?.connector ?? null;
  const cantSee = input.coverage.flatMap((c): Array<{ kind: OutcomeKind; why: "not_shared" | "failed" | "not_connected"; connector: string | null; href: string | null }> => {
    if (c.state === "measured") return [];
    if (c.state !== "not_connected") return [{ kind: c.kind, why: c.state, connector: c.connector.slice(0, 80), href: c.href }];
    // A whole site total would weigh nothing here: only a connector that counts by page is named.
    const first = c.could.find((x) => !x.siteOnly);
    return [{ kind: c.kind, why: c.state, connector: first ? first.name.slice(0, 80) : null, href: first?.href ?? null }];
  });
  const keyWord = keyActionWord(input.approved.goal?.measure);
  for (const rule of RULES) {
    for (const hit of rule(input)) {
      if (isHeld(input.holds, hit.detail.kind, hit.about, input.nowIso)) continue;
      // One that can't be kept is passed over for the next: it never stops the month from being kept.
      const parsed = StrategySuggestionSchema.safeParse({
        key: suggestionKey(hit.detail.kind, hit.about),
        about: hit.about,
        month: now.month,
        raisedAt: input.nowIso,
        detail: hit.detail,
        keyWord,
        basedOn: { builtIn: hit.builtIn, measured: hit.measured.flatMap((k) => (connectorOf(k) ? [{ kind: k, connector: connectorOf(k)! }] : [])) },
        cantSee,
        state: "open",
      });
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

/**
 * The suggestion to keep after a month's look: the new one replaces whatever was there, keeping when
 * it was first raised if it is the same one still open. Null when no rule applies: last month's
 * suggestion is about last month. Pure.
 */
export function nextSuggestion(current: StrategySuggestion | null, picked: StrategySuggestion | null): StrategySuggestion | null {
  if (!picked) return null;
  if (current && current.state === "open" && current.key === picked.key) return { ...picked, raisedAt: current.raisedAt };
  return picked;
}

/** What working out the month's suggestion needs of the strategy record. */
export interface SuggestRecord extends Pick<MonthRecord, "approved" | "history"> {
  approved: (Pick<Strategy, "at" | "focusSituationIds" | "claims" | "goal">) | null;
  history: ReadonlyArray<Pick<Strategy, "at" | "claims">>;
  months: readonly StrategyMonth[];
  suggestion: StrategySuggestion | null;
  suggestHolds: readonly SuggestHold[];
}

/**
 * What keeping a month writes for the suggestion (STRATEGY_SUGGEST_ENABLED): the month's suggestion
 * from the months that count (the one just kept first), the approved strategy, the plan and the
 * look's reads, and the holds still in force. Pure.
 */
export function suggestAfterLook(doc: SuggestRecord, look: StrategyMonth, input: MonthInput, nowIso: string): { suggestion: StrategySuggestion | null; suggestHolds: SuggestHold[] } {
  const holds = liveHolds(doc.suggestHolds, nowIso);
  if (!doc.approved) return { suggestion: null, suggestHolds: holds };
  const months = [look, ...doc.months.filter((m) => m.month !== look.month)].filter((m) => monthCounts(doc, m.month)).sort((a, b) => b.month.localeCompare(a.month));
  const picked = pickSuggestion({
    nowIso,
    months,
    approved: doc.approved,
    history: doc.history,
    plan: input.plan && input.behind ? { at: input.plan.at, behind: input.behind } : null,
    situations: input.situations,
    theirs: input.theirs,
    articles: input.articles,
    byPage: input.outcomes.byPage,
    coverage: input.outcomes.coverage,
    holds,
  });
  return { suggestion: nextSuggestion(doc.suggestion, picked), suggestHolds: holds };
}

/** Whether a suggestion makes a Review row: open, and not a line for How it went. */
export const isReviewSuggestion = (s: StrategySuggestion | null | undefined): s is StrategySuggestion => Boolean(s && s.state === "open" && s.detail.kind !== "working");

// ----- Its words ---------------------------------------------------------------------------------

/** "A", "A and B", "A, B and C" (or "or"). */
const listOf = (items: readonly string[], last = "and") => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`);
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
/** A situation's, a claim's or an article's words inside quotes, without a closing full stop (a question keeps its mark). */
const quoted = (text: string) => `"${clipText(text, 100).replace(/\.+$/, "")}"`;

/** What a kind's number is called in a sentence ("no search clicks"); key actions in the brand's own word. */
export function resultNoun(kind: OutcomeKind, keyWord: string | null): string {
  if (kind === "key_actions") return keyWord ?? "sign-ups";
  return { search: "search clicks", visits: "visits", ai_answers: "AI citations" }[kind];
}

/** The same for one ("1 search click", "1 enquiry"), from each word's own singular. */
export function resultNounOne(kind: OutcomeKind, keyWord: string | null): string {
  if (kind === "key_actions") return keyWord ? (KEY_ACTION_WORDS[keyWord] ?? keyWord) : "sign-up";
  return { search: "search click", visits: "visit", ai_answers: "AI citation" }[kind];
}

/** What connecting a kind would let the strategy tell, after "can tell". */
function tells(kind: OutcomeKind, keyWord: string | null): string {
  if (kind === "search") return "which situations people find you for in search";
  if (kind === "ai_answers") return "which situations get you cited in AI answers";
  return `which situations bring ${resultNoun(kind, keyWord)}`;
}

const BUILT_IN_WORDS: Record<SuggestBuiltIn, string> = {
  articles: "your articles",
  roadmap: "your content plan",
  claims: "your approved claims",
  questions: "your brand map's questions",
  their_articles: "your competitors' articles",
  connections: "what you've connected",
};

/**
 * The words Review, the Strategy tab and Vizzy give a suggestion, as lines. Client safe; the help
 * pages quote some of them. House style: no dashes as punctuation.
 */
export const SUGGEST_WORDS = {
  title: "Your strategy's month",
  review: "Review the strategy",
  notNow: "Not now",
  notNowAsk: "Why not now?",
  notePlaceholder: "Anything to add (optional)",
  save: "Save",
  cancel: "Cancel",
  saved: "It stays away for now. Its reason is kept with your strategy.",
  share: "Share it",
  onTab: "This month's suggestion",
  takesNote: "Propose with Vizzy takes it as a note to its draft. Nothing changes until you approve.",
  proposedWith: "Your draft was proposed with this suggestion. Approve it to act on it.",
  reasons: NOT_NOW_LABEL,
} as const;

/** The suggestion itself, in a line or two. Pure. */
export function suggestionLines(s: Pick<StrategySuggestion, "detail" | "keyWord">): string[] {
  const d = s.detail;
  if (d.kind === "behind_plan") {
    const titles = listOf(d.entries.map((e) => quoted(e.title)));
    const these = d.entries.length;
    return d.behind > these
      ? [`${plural(d.behind, "article", "articles")} your content plan had due aren't live yet, among them ${titles}.`, `Write or move these ${these} first.`]
      : [`${plural(d.behind, "article", "articles")} your content plan had due aren't live yet: ${titles}.`, `Write or move these ${these}.`];
  }
  if (d.kind === "stalled_focus") {
    const nouns = listOf(d.kinds.map((k) => resultNoun(k, s.keyWord)), "or");
    const why =
      d.swap.by === "their_articles"
        ? `your competitors wrote ${plural(d.swap.count, "article", "articles")} on it in the last 90 days`
        : d.swap.by === "result" && d.swap.outcome
          ? `its articles had ${plural(d.swap.count, resultNounOne(d.swap.outcome, s.keyWord), resultNoun(d.swap.outcome, s.keyWord))} in the latest 28 days`
          : `${plural(d.swap.count, "of its questions has", "of its questions have")} no live answer yet`;
    return [`${quoted(d.text)} has had no new article and no ${nouns} for ${S.months} months, while the rest of your map moved.`, `Swap it for ${quoted(d.swap.text)}: ${why}.`];
  }
  if (d.kind === "claim_no_proof") return [`Your claim ${quoted(d.text)} has had no proof for ${d.months} months.`, "Add the page that proves it, or drop it."];
  if (d.kind === "measure_more") {
    const names = d.connectors.map((c) => c.name);
    return d.why === "not_shared"
      ? [`Share ${names[0]} with your team and Vizzy so your strategy can tell ${tells(d.outcome, s.keyWord)}.`]
      : [`Connect ${listOf(names, "or")} so your strategy can tell ${tells(d.outcome, s.keyWord)}.`];
  }
  const noun = resultNoun(d.outcome, s.keyWord);
  return [`Your focus situations are working: their ${noun} went from ${d.focusBefore.toLocaleString("en-GB")} to ${d.focusNow.toLocaleString("en-GB")}, ahead of the rest of your map (${d.restBefore.toLocaleString("en-GB")} to ${d.restNow.toLocaleString("en-GB")}).`];
}

/** "From your articles and Google Search Console." Pure. */
export function basedOnLine(s: Pick<StrategySuggestion, "basedOn">): string {
  const parts = [...s.basedOn.builtIn.map((b) => BUILT_IN_WORDS[b]), ...new Set(s.basedOn.measured.map((m) => m.connector))];
  return parts.length ? `From ${listOf(parts)}.` : "";
}

/** "Connect Google Analytics 4 to weigh visits and sign-ups too." for each tool that would add a kind. Pure. */
export function cantSeeLine(s: Pick<StrategySuggestion, "cantSee" | "keyWord">): string {
  const groups = new Map<string, { verb: string; connector: string; nouns: string[] }>();
  for (const c of s.cantSee) {
    if (!c.connector) continue;
    const verb = c.why === "not_connected" ? "Connect" : c.why === "not_shared" ? "Share" : "Check";
    const key = `${verb}|${c.connector}`;
    const g = groups.get(key) ?? { verb, connector: c.connector, nouns: [] };
    g.nouns.push(resultNoun(c.kind, s.keyWord));
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) =>
      g.verb === "Share"
        ? `Share ${g.connector} with your team and Vizzy to weigh ${listOf(g.nouns)} too.`
        : g.verb === "Check"
          ? `Check ${g.connector}'s connection to weigh ${listOf(g.nouns)} too.`
          : `Connect ${g.connector} to weigh ${listOf(g.nouns)} too.`,
    )
    .join(" ");
}

/** What it was based on and what it couldn't see, in one line (none for Measure more: that is what it is about). Pure. */
export function sourcesLine(s: Pick<StrategySuggestion, "basedOn" | "cantSee" | "keyWord" | "detail">): string {
  if (s.detail.kind === "measure_more") return "";
  return [basedOnLine(s), cantSeeLine(s)].filter(Boolean).join(" ");
}

/** Where its button goes: the Strategy tab, or for Measure more the connector's Connect page or where sharing is set. Pure. */
export function suggestionAction(s: Pick<StrategySuggestion, "detail">, strategyHref: string): { label: string; href: string } {
  const d = s.detail;
  if (d.kind !== "measure_more" || !d.connectors[0]) return { label: SUGGEST_WORDS.review, href: strategyHref };
  return d.why === "not_shared" ? { label: SUGGEST_WORDS.share, href: d.connectors[0].href } : { label: `Connect ${d.connectors[0].name}`, href: d.connectors[0].href };
}

/** What the suggestion said, for its decision and Propose's note: its lines, then what it stood on. Pure. */
export function suggestionSaid(s: Pick<StrategySuggestion, "detail" | "keyWord" | "basedOn" | "cantSee">): string {
  return [...suggestionLines(s), sourcesLine(s)].filter(Boolean).join(" ");
}
