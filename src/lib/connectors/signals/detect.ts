import { embedDocuments } from "@/lib/agents/embeddings";
import { isBrandMapEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { nearestSubjectsMany } from "@/lib/brandMap/embed";
import { proposedQuestion } from "@/lib/brandMap/proposals";
import { subjectQuestions } from "@/lib/brandMap/records";
import { readBrandMap } from "@/lib/brandMap/store";
import { meaningWords } from "@/lib/content/blog/coverage";
import { listOpenAgentActions } from "@/lib/ontology/agentActions";
import { changeDataConnection, proposeAgentAction, transitionAgentAction, type TenantContext } from "@/lib/tenant";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike } from "@/lib/tenant/types";
import { agentDedupeKey, type AgentAction, type SignalRef } from "@/lib/types/agentAction";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { DataSignal, DataSignalRule } from "@/lib/types/dataSignal";
import type { MetricSnapshot, SnapshotRow } from "@/lib/types/metricSnapshot";
import { pendingWith } from "../erase";
import { feedsPlanning } from "../grants";
import { collectedStream } from "../manifest";
import { planningId, rolledId, topicKey } from "../keys";
import { ga4Manifest } from "../manifests/ga4";
import { searchConsoleManifest } from "../manifests/searchConsole";
import { addDays, daysIn, todayIn } from "../period";
import { compareRows, putSnapshot, readDayDocs, readSnapshot, ttlFor } from "../snapshots";
import { proposalReason } from "./words";
import { DATA_SIGNAL_ACTION, EXPIRY_DAYS, PROPOSE_QUESTION_ACTION, SIGNALS_AGENT, SIGNALS_REVIEW_HREF } from "./names";
import { blankSignal, getSignal, linkAction, saveDetection, signalIdFor, type Detection } from "./store";

/**
 * What collected numbers suggest (Connectors 2 group 4, CONNECTOR_SIGNALS_ENABLED, ADR-0012): pure
 * rules over a Search Console connection's final days, run once a day by the lane after a day
 * lands, from planning connections only (members and Vizzy may both read them), and only where the
 * brand map has decided subjects.
 *
 * - Rising search: at least 50 impressions in the last 14 final days, on 4 days or more, and at
 *   least double the 14 days before (80 when it is new), with no question on the brand map with the
 *   same words or close to it in meaning.
 * - Page losing clicks: at least 40 clicks in the 28 days before, then down by 40% or more and by at
 *   least 20 clicks. Needs all 56 days collected. When the page is also a Google Analytics landing
 *   page, its sessions come as a second line (no Google Analytics signal of its own).
 * - Within reach: a decided question whose search averages position 5 to 20, with at least 100
 *   impressions over 28 days.
 *
 * A row cut from a day (each day keeps its top 500) is not a zero: on a day whose rows were cut, a
 * missing search or page counts as at most that day's floor. Each rule takes the side that makes it
 * fire less: the recent numbers count a missing day as nothing where more would help the rule (a
 * rising search's last 14 days, a page's 28 days before), and as its floor where more would stop it
 * (the 14 days before a rising search, a page's last 28 days). So a row that only slipped under the
 * cut never fires. Rows are ranked by clicks first (Google sends them that way, ties in no fixed
 * order), so a floor's clicks bound a missing row's clicks, but its impressions bound a missing
 * search's impressions only on a day whose floor had no clicks and whose rows Google sent in full:
 * a rising search missing from any other cut day in the 14 before has an unknown earlier figure and
 * never fires.
 *
 * Caps: at most 5 new suggestions a brand a day and 15 open at once, strongest first (how far past
 * its threshold each is). Each one is an agent action (agent `connector_signals`, no person,
 * expiring in 30 days, its values cleared when it closes), indexed by a `data_signals` row. While a
 * suggestion is open nothing new is proposed for it; a dismissed or planned one stays away 30
 * days. An open suggestion whose rule was checked again and no longer holds is declined as stale.
 *
 * Detection also writes Search Console's subject planning doc (`subject_r28`): the top 100 searches
 * of the 28 days, each mapped to its nearest decided subject by meaning (nearestSubjectsMany), so
 * Next up and the context pack can say how much demand sits near a subject.
 */

export const RULES = {
  rising: { days: 14, minImpressions: 50, factor: 2, newImpressions: 80, minDaysSeen: 4 },
  losing: { days: 28, minClicks: 40, dropShare: 0.4, minDrop: 20 },
  reach: { minPosition: 5, maxPosition: 20, minImpressions: 100 },
} as const;
export const CAPS = { newPerDay: 5, open: 15 } as const;
/** The searches mapped to subjects for the subject planning doc. */
export const TOP_SEARCHES = 100;
/** A search this close to a subject counts as near it. */
export const NEAR_SUBJECT = 0.6;
/** A rising search this close in meaning to a question on the map is already answered by it. */
export const NEAR_QUESTION = 0.85;
/** Rows one rule writes in a run, strongest first. */
export const ROWS_PER_RULE = 30;
/** Questions read for each subject a rising search sits near. */
const QUESTIONS_PER_SUBJECT = 60;


const DAY_MS = 86_400_000;
const SEARCH_STREAM = searchConsoleManifest.produces[0]!.stream;
const SEARCH_KEEP_DAYS = collectedStream(searchConsoleManifest)?.collect.keepDays ?? 90;

// --- Tallies (pure) ----------------------------------------------------------------------------

/** One key's numbers over a window: each half added up, and the days it was on. */
export interface KeyTally {
  label: string;
  host?: string;
  before: Record<string, number>;
  now: Record<string, number>;
  /** Bit i: on the window's day i of its half. */
  beforeDays: number;
  nowDays: number;
}

/** A window of day docs for one grouping, split into the days before and the recent days. */
export interface Tally {
  days: string[];
  /** The index of the first recent day. */
  split: number;
  present: boolean[];
  cut: boolean[];
  /**
   * A cut day whose floor bounds a missing search's impressions: Google sent every row (no `more`)
   * and the floor had no clicks, so every row left out had none and no more impressions than it.
   */
  bounded: boolean[];
  floors: Array<Record<string, number>>;
  keys: Map<string, KeyTally>;
}

/** An empty tally for `beforeDays` days and then `nowDays` days, ending on `to`. */
export function newTally(to: string, beforeDays: number, nowDays: number): Tally {
  const total = beforeDays + nowDays;
  const days = Array.from({ length: total }, (_, i) => addDays(to, i - total + 1));
  return { days, split: beforeDays, present: days.map(() => false), cut: days.map(() => false), bounded: days.map(() => false), floors: days.map(() => ({})), keys: new Map() };
}

/** The key a row is tallied under, and its label: a search's topic, or a page on its host. */
export type KeyOf = (r: SnapshotRow) => { key: string; label: string; host?: string } | null;
export const topicOf: KeyOf = (r) => {
  const key = topicKey(r.key);
  return key ? { key, label: r.key.replace(/\s+/g, " ").trim() } : null;
};
export const pageOf: KeyOf = (r) => (r.key ? { key: `${r.host ?? ""}\u0000${r.key}`, label: r.key, ...(r.host ? { host: r.host } : {}) } : null);

/** Add one day doc to a tally (a doc outside its window is left out). */
export function addDay(t: Tally, doc: Pick<MetricSnapshot, "day" | "rows" | "rowsDropped" | "more" | "floor">, keyOf: KeyOf): void {
  const i = doc.day ? t.days.indexOf(doc.day) : -1;
  if (i < 0) return;
  t.present[i] = true;
  t.cut[i] = doc.rowsDropped > 0 || doc.more;
  t.bounded[i] = !doc.more && (!doc.floor || doc.floor.searchClicks === 0);
  t.floors[i] = doc.floor ?? (doc.rows.length ? { ...doc.rows[doc.rows.length - 1]!.m } : {});
  const recent = i >= t.split;
  const bit = 1 << (recent ? i - t.split : i);
  for (const r of doc.rows) {
    const k = keyOf(r);
    if (!k) continue;
    const acc = t.keys.get(k.key) ?? { label: k.label, ...(k.host ? { host: k.host } : {}), before: {}, now: {}, beforeDays: 0, nowDays: 0 };
    acc.label = k.label;
    const into = recent ? acc.now : acc.before;
    for (const [m, v] of Object.entries(r.m)) if (typeof v === "number" && m !== "searchPosition" && m !== "searchCtr") into[m] = (into[m] ?? 0) + v;
    if (recent) acc.nowDays |= bit;
    else acc.beforeDays |= bit;
    t.keys.set(k.key, acc);
  }
}

const bits = (n: number) => {
  let c = 0;
  for (let x = n >>> 0; x; x &= x - 1) c += 1;
  return c;
};

/** What a key's missing days add at their floors: those of its half whose rows were cut. */
function atFloors(t: Tally, k: KeyTally, recent: boolean, measure: string): number {
  let add = 0;
  const from = recent ? t.split : 0;
  const to = recent ? t.days.length : t.split;
  const mask = recent ? k.nowDays : k.beforeDays;
  for (let i = from; i < to; i++) {
    if (!t.cut[i] || mask & (1 << (i - from))) continue;
    add += t.floors[i]?.[measure] ?? 0;
  }
  return add;
}

/**
 * A search's impressions in the 14 days before, its missing cut days at their floors: null when a
 * cut day's floor can't bound them (see `bounded`), so the earlier figure is unknown.
 */
function impressionsBefore(t: Tally, k: KeyTally): { before: number; add: number } | null {
  let add = 0;
  for (let i = 0; i < t.split; i++) {
    if (!t.cut[i] || k.beforeDays & (1 << i)) continue;
    if (!t.bounded[i]) return null;
    add += t.floors[i]?.searchImpressions ?? 0;
  }
  return { before: (k.before.searchImpressions ?? 0) + add, add };
}

/** Every day of the window has its doc (a day the provider listed nothing has a doc too). */
export const isComplete = (t: Tally) => t.present.every(Boolean);

export interface RisingHit {
  key: string;
  label: string;
  impressions: number;
  clicks: number;
  /** The 14 days before, with cut days at their floors. */
  before: number;
  atMost: boolean;
  daysSeen: number;
  strength: number;
}

/** Rising searches in a 28 day topic tally (14 before, 14 recent), strongest first. Null when a day is missing. */
export function risingSearches(t: Tally): RisingHit[] | null {
  if (!isComplete(t)) return null;
  const r = RULES.rising;
  const out: RisingHit[] = [];
  for (const [key, k] of t.keys) {
    const impressions = k.now.searchImpressions ?? 0;
    const daysSeen = bits(k.nowDays);
    if (impressions < r.minImpressions || daysSeen < r.minDaysSeen) continue;
    const earlier = impressionsBefore(t, k);
    if (!earlier) continue;
    const { before, add } = earlier;
    if (before === 0 ? impressions < r.newImpressions : impressions < r.factor * before) continue;
    out.push({ key, label: k.label, impressions, clicks: k.now.searchClicks ?? 0, before, atMost: add > 0, daysSeen, strength: (impressions - before) / r.minImpressions });
  }
  return out.sort((a, b) => b.strength - a.strength || a.key.localeCompare(b.key));
}

export interface LosingHit {
  key: string;
  label: string;
  host?: string;
  /** The last 28 days, with cut days at their floors. */
  clicks: number;
  before: number;
  atMost: boolean;
  strength: number;
}

/** Pages losing clicks in a 56 day page tally (28 before, 28 recent), strongest first. Null when a day is missing. */
export function losingPages(t: Tally): LosingHit[] | null {
  if (!isComplete(t)) return null;
  const r = RULES.losing;
  const out: LosingHit[] = [];
  for (const [key, k] of t.keys) {
    const before = k.before.searchClicks ?? 0;
    if (before < r.minClicks) continue;
    const add = atFloors(t, k, true, "searchClicks");
    const clicks = (k.now.searchClicks ?? 0) + add;
    if (before - clicks < r.minDrop || clicks > (1 - r.dropShare) * before) continue;
    out.push({ key, label: k.label, ...(k.host ? { host: k.host } : {}), clicks, before, atMost: add > 0, strength: (before - clicks) / r.minDrop });
  }
  return out.sort((a, b) => b.strength - a.strength || a.key.localeCompare(b.key));
}

export interface ReachHit {
  questionId: string;
  subjectId: string | null;
  label: string;
  position: number;
  impressions: number;
  clicks: number;
  strength: number;
}

/**
 * Decided questions within reach, from the questions' planning doc, strongest first. A search that
 * fell under a day's cut has an average position from its best days only, which can't be bounded,
 * so it never fires.
 */
export function withinReach(doc: Pick<MetricSnapshot, "rows"> | null): ReachHit[] {
  const r = RULES.reach;
  const out: ReachHit[] = [];
  for (const row of doc?.rows ?? []) {
    if ((row.cutDays ?? 0) > 0) continue;
    const p = row.m.searchPosition;
    const i = row.m.searchImpressions ?? 0;
    if (typeof p !== "number" || p < r.minPosition || p > r.maxPosition || i < r.minImpressions || !row.label) continue;
    out.push({ questionId: row.key, subjectId: row.subjectId ?? null, label: row.label, position: p, impressions: i, clicks: row.m.searchClicks ?? 0, strength: i / r.minImpressions });
  }
  return out.sort((a, b) => b.strength - a.strength || a.questionId.localeCompare(b.questionId));
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** Whether a search's meaningful words are all in a question's, when meaning can't be had. */
export function nearByWords(search: string, question: string): boolean {
  const s = meaningWords(search);
  if (!s.length) return false;
  const q = new Set(meaningWords(question));
  return s.every((w) => q.has(w));
}

// --- The brand map, as the rules need it --------------------------------------------------------

/** A decided subject a search can sit near, and a question on the map. */
export interface MapView {
  atScale: boolean;
  subjects: number;
  /** Every question's words on the map (topic keys), whatever its state. */
  hasWords: (keys: string[]) => Promise<Set<string>>;
  /** A subject's questions (decided and proposed), for closeness in meaning. */
  questionsOf: (subjectId: string) => Promise<string[]>;
  /** The question's words, by id. */
  questionText: (ids: string[]) => Promise<Map<string, string>>;
  /** The nearest decided subject of each text, or null. */
  nearest: (texts: string[]) => Promise<Array<{ ref: string; sim: number } | null>>;
  /**
   * At any size: propose a question under a subject (from `search_console`, with the connection
   * that found it), answering its id, or null when the map already has those words or had them
   * dismissed.
   */
  propose?: (input: { subjectId: string; text: string; reason: string; evidence: string; connectionId: string; now: string }) => Promise<string | null>;
  /** At any size: whether a question is still on the map, in any state. */
  questionExists?: (id: string) => Promise<boolean>;
}

export interface DetectDeps {
  db?: FirestoreLike;
  now?: Date;
  clock?: () => number;
  /** The brand map's view (tests stub it); default reads the map. */
  map?: (ctx: TenantContext) => Promise<MapView | null>;
  embed?: typeof embedDocuments;
}

/** Shared meaningful words as a share of the subject name's: the word fallback of nearest. */
function byWords(subjects: Array<{ id: string; name: string }>, text: string): { ref: string; sim: number } | null {
  const words = new Set(meaningWords(text));
  let best: { ref: string; sim: number } | null = null;
  for (const s of subjects) {
    const own = meaningWords(s.name);
    const sim = own.length ? own.filter((w) => words.has(w)).length / own.length : 0;
    if (sim > 0 && (!best || sim > best.sim)) best = { ref: s.id, sim };
  }
  return best;
}

/** The brand map as detection reads it: the map at any size by its records, else its one record. */
export async function readMapView(ctx: TenantContext, deps: Pick<DetectDeps, "db"> = {}): Promise<MapView | null> {
  if (!isBrandMapEnabled()) return null;
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (!read || read.state !== "ok") return null;
  const map = read.map;
  if (isBrandMapScaleEnabled() && map.moved) {
    const store = brandMapRecords(ctx, deps.db);
    const subjects = await store.count("sub", [["status", "==", "decided"]]).catch(() => 0);
    return {
      atScale: true,
      subjects,
      hasWords: async (keys) => new Set((await store.findIn("q", "textKey", keys).catch(() => [])).map((r) => String(r.textKey ?? ""))),
      questionsOf: async (id) => (await subjectQuestions(ctx, id, { db: deps.db }).catch(() => [])).slice(0, QUESTIONS_PER_SUBJECT).map((q) => q.text),
      questionText: async (ids) => new Map((await store.getMany("q", ids).catch(() => [])).map((r) => [r.ref, String(r.text ?? "")] as const)),
      nearest: async (texts) =>
        (await nearestSubjectsMany(ctx, texts, { limit: 1, statuses: ["decided"] }, { db: deps.db }).catch(() => texts.map(() => []))).map((n) => (n[0] ? { ref: n[0].ref, sim: n[0].sim } : null)),
      propose: async (p) => {
        const made = await proposedQuestion(ctx, store, { subjectId: p.subjectId, text: p.text, from: "search_console", reason: p.reason, evidence: p.evidence, now: p.now, fromConnectionId: p.connectionId });
        return made ? String(made.ref) : null;
      },
      questionExists: async (id) => (await store.get("q", id).catch(() => null)) !== null,
    };
  }
  const subjects = map.subjects;
  const questions = subjects.flatMap((s) => s.questions.map((q) => ({ ...q, subjectId: s.id })));
  return {
    atScale: false,
    subjects: subjects.length,
    hasWords: async (keys) => {
      const on = new Set(questions.map((q) => topicKey(q.text)));
      return new Set(keys.filter((k) => on.has(k)));
    },
    questionsOf: async (id) => questions.filter((q) => q.subjectId === id).map((q) => q.text),
    questionText: async (ids) => new Map(questions.filter((q) => ids.includes(q.id)).map((q) => [q.id, q.text] as const)),
    nearest: async (texts) => texts.map((t) => byWords(subjects, t)),
  };
}

// --- One connection ----------------------------------------------------------------------------

export interface DetectResult {
  status: "detected" | "skipped";
  reason?: string;
  fired: Record<DataSignalRule, number>;
  /** Rules that were checked (each needs its days collected). */
  checked: DataSignalRule[];
  proposed: number;
  refreshed: number;
  stale: number;
}

const skipped = (reason: string): DetectResult => ({ status: "skipped", reason, fired: { rising_search: 0, losing_page: 0, within_reach: 0 }, checked: [], proposed: 0, refreshed: 0, stale: 0 });

/** A candidate suggestion before the caps. */
interface Candidate {
  detection: Detection;
  strength: number;
}

/** The open suggestions from collected numbers, of both kinds, not past their expiry. */
export async function openConnectorSuggestions(ctx: TenantContext, deps: { db?: FirestoreLike; now?: Date } = {}): Promise<AgentAction[]> {
  const now = (deps.now ?? new Date()).toISOString();
  const lists = await Promise.all([DATA_SIGNAL_ACTION, PROPOSE_QUESTION_ACTION].map((action) => listOpenAgentActions(ctx, { action, limit: 50, now, db: deps.db })));
  return lists.flat().filter((a) => a.agent === SIGNALS_AGENT);
}

/**
 * Up to 4 metric signals for an action: references with meaning keys, never words, and never the
 * numbers themselves, which sit in the proposal and are cleared when it closes (decision 25):
 * signals outlive the decision, and agent actions have no time to live.
 */
function metricSignals(d: Detection, at: string): SignalRef[] {
  const ref = `${d.connectionId}:${d.window.to}`;
  const keys = d.rule === "within_reach" ? ["searchPosition", "searchImpressions"] : d.rule === "losing_page" ? ["searchClicks", "ga4Sessions"] : ["searchImpressions", "searchClicks"];
  return keys
    .filter((k) => typeof d.numbers[k] === "number")
    .slice(0, 4)
    .map((k) => ({ kind: "metric" as const, ref, meaning: k as SignalRef["meaning"], at }));
}

/** Propose a Review suggestion for a row: a new round, so a closed one's key is never reused. */
async function proposeSuggestion(ctx: TenantContext, row: DataSignal, d: Detection, now: Date, deps: Pick<DetectDeps, "db">): Promise<boolean> {
  const round = (row.round ?? 0) + 1;
  const at = now.toISOString();
  const r = await proposeAgentAction(
    ctx,
    {
      dedupeKey: agentDedupeKey(DATA_SIGNAL_ACTION, row.id, `r${round}`),
      agent: SIGNALS_AGENT,
      action: DATA_SIGNAL_ACTION,
      target: { type: "data_signal", id: row.id },
      personId: null,
      proposal: { rule: d.rule, connectionId: d.connectionId, gen: d.gen, label: d.label, question: d.question ?? null, numbers: d.numbers, before: d.before ?? null, window: d.window },
      basis: null,
      signals: [{ kind: "data_signal", ref: row.id }, ...metricSignals(d, at)],
      review: { kind: "data_signal", href: SIGNALS_REVIEW_HREF },
      requestedBy: { type: "system", id: SIGNALS_AGENT },
      expiresAt: new Date(now.getTime() + EXPIRY_DAYS * DAY_MS).toISOString(),
      clearDetailsOnClose: true,
      at,
    },
    { db: deps.db },
  );
  if (r.outcome !== "created") return false;
  await linkAction(ctx, row.id, r.action.id, round, { db: deps.db });
  return true;
}

/**
 * A rising search at any size: proposed as a question in the search's own words under its nearest
 * subject, waiting on the brand map (no Review row of its own: the brand map row counts it), and
 * recorded as an agent action about that question.
 */
async function proposeQuestion(ctx: TenantContext, row: DataSignal, d: Detection, map: MapView, now: Date, deps: Pick<DetectDeps, "db">): Promise<boolean> {
  if (!d.subjectId || !map.propose) return false;
  const at = now.toISOString();
  const questionId = await map.propose({ subjectId: d.subjectId, text: d.label, reason: proposalReason({ ...d, before: d.before ?? null, atMost: d.atMost ?? false }), evidence: d.label, connectionId: d.connectionId, now: at });
  if (!questionId) return false;
  const round = (row.round ?? 0) + 1;
  const r = await proposeAgentAction(
    ctx,
    {
      dedupeKey: agentDedupeKey(PROPOSE_QUESTION_ACTION, questionId, `r${round}`),
      agent: SIGNALS_AGENT,
      action: PROPOSE_QUESTION_ACTION,
      target: { type: "brand_question", id: questionId },
      personId: null,
      proposal: { rule: d.rule, connectionId: d.connectionId, gen: d.gen, questionId, subjectId: d.subjectId, label: d.label, numbers: d.numbers, before: d.before ?? null, window: d.window },
      basis: null,
      signals: [{ kind: "data_signal" as const, ref: row.id }, { kind: "brand_map" as const, ref: questionId }, ...metricSignals(d, at)],
      review: null,
      requestedBy: { type: "system", id: SIGNALS_AGENT },
      expiresAt: new Date(now.getTime() + EXPIRY_DAYS * DAY_MS).toISOString(),
      clearDetailsOnClose: true,
      at,
    },
    { db: deps.db },
  );
  if (r.outcome !== "created") return false;
  await linkAction(ctx, row.id, r.action.id, round, { db: deps.db, questionId });
  return true;
}

/** Close an open suggestion its rule no longer backs: declined as stale, values cleared, the row blanked. */
async function setStale(ctx: TenantContext, a: AgentAction, at: string, deps: Pick<DetectDeps, "db">): Promise<boolean> {
  const r = await transitionAgentAction(ctx, a.id, { to: "declined", reason: "stale", by: { type: "system", id: SIGNALS_AGENT }, at, expectRev: a.rev, clearDetails: true }, { db: deps.db });
  if (r.ok) await blankSignal(ctx, a.target.id, { db: deps.db });
  return r.ok;
}

/**
 * Look at one Search Console connection's collected days for suggestions, once a day after a day
 * lands. `others` are the brand's other connections, for a Google Analytics line on a page losing
 * clicks. Never throws for missing days: a rule whose days aren't all collected is not checked.
 *
 * Detection holds no lease, so Disconnect or Change property can land while it writes. Its last
 * change looks again: a connection no longer connected, or on a newer generation, gets what this
 * look wrote (rows, suggestions, proposed questions, the subject planning doc) marked for erasing,
 * which the lane's housekeeping does on its next run. That happens even when the look failed half
 * way.
 */
export async function detectConnection(ctx: TenantContext, conn: DataConnection, others: readonly DataConnection[], deps: DetectDeps = {}): Promise<DetectResult> {
  const now = deps.now ?? new Date(deps.clock?.() ?? Date.now());
  const c = conn.collect;
  let done = false;
  try {
    const result = await detectNow(ctx, conn, others, deps, now);
    done = result.status === "detected";
    return result;
  } finally {
    if (c) await settle(ctx, conn.id, c.gen, done ? todayIn(now, "UTC") : null, deps).catch((err) => console.warn(`[connectors] settling a look at ${conn.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error"));
  }
}

/**
 * After a look: record the day it was done, and mark for erasing what it wrote when the connection
 * was disconnected or changed property meanwhile. Nothing to do otherwise.
 */
async function settle(ctx: TenantContext, id: string, gen: number, detectedOn: string | null, deps: Pick<DetectDeps, "db">): Promise<void> {
  await changeDataConnection(
    ctx,
    id,
    (cur) => {
      const k = cur.collect;
      if (!k) return null;
      const moved = cur.status !== "connected" || k.gen !== gen;
      if (!moved && !detectedOn) return null;
      return {
        patch: {
          collect: {
            ...k,
            ...(detectedOn && !moved ? { detectedOn } : {}),
            ...(moved ? { erasePending: pendingWith(k.erasePending, cur.status !== "connected" ? "all" : [gen]) } : {}),
          },
        },
        activity: [],
      };
    },
    deps.db,
  );
}

async function detectNow(ctx: TenantContext, conn: DataConnection, others: readonly DataConnection[], deps: DetectDeps, now: Date): Promise<DetectResult> {
  const store = { db: deps.db, now };
  const c = conn.collect;
  if (conn.connectorId !== searchConsoleManifest.id || conn.status !== "connected" || !conn.account) return skipped("not_search_console");
  if (!feedsPlanning(conn.grants)) return skipped("not_for_planning");
  if (!c?.lastDay || !c.backfilledTo) return skipped("nothing_collected");
  const map = await (deps.map ?? ((x) => readMapView(x, { db: deps.db })))(ctx);
  if (!map || map.subjects === 0) return skipped("no_subjects");

  const owner = { id: conn.id, gen: c.gen };
  const last = c.lastDay;
  const base = { connectionId: conn.id, gen: c.gen, account: conn.account, connectorId: conn.connectorId };
  const result: DetectResult = { status: "detected", fired: { rising_search: 0, losing_page: 0, within_reach: 0 }, checked: [], proposed: 0, refreshed: 0, stale: 0 };
  const candidates: Candidate[] = [];
  /** Rows whose rule holds this run, though past the rows a rule writes: never stale. */
  const holding = new Set<string>();
  const idOf = (rule: DataSignalRule, key: Detection["key"]) => signalIdFor(ctx.tenantId, conn.id, c.gen, rule, key);

  // Rising searches: the 28 topic days.
  const r = RULES.rising;
  const topics = newTally(last, r.days, r.days);
  let rising: RisingHit[] | null = null;
  if (c.backfilledTo <= topics.days[0]!) {
    await readDayDocs(ctx, owner, SEARCH_STREAM, "topic", topics.days[0]!, last, { ...store, each: (doc) => addDay(topics, doc, topicOf) });
    rising = risingSearches(topics);
  }
  topics.keys.clear();

  // Pages losing clicks: the 56 page days.
  const l = RULES.losing;
  const pages = newTally(last, l.days, l.days);
  let losing: LosingHit[] | null = null;
  if (c.backfilledTo <= pages.days[0]!) {
    await readDayDocs(ctx, owner, SEARCH_STREAM, "page", pages.days[0]!, last, { ...store, each: (doc) => addDay(pages, doc, pageOf) });
    losing = losingPages(pages);
  }
  pages.keys.clear();

  // Within reach: the questions' planning doc.
  const questionsDoc = await readSnapshot(ctx, planningId(conn.id, c.gen, SEARCH_STREAM, "question"), store);
  const reach = questionsDoc ? withinReach(questionsDoc) : null;

  // The subject planning doc, and each rising search's nearest subject, in one lookup.
  const topDoc = await readSnapshot(ctx, rolledId(conn.id, c.gen, SEARCH_STREAM, "topic", "r28"), store);
  const top = [...(topDoc?.rows ?? [])].sort(compareRows).slice(0, TOP_SEARCHES);
  const risingTop = (rising ?? []).slice(0, ROWS_PER_RULE);
  const texts = [...top.map((t) => t.key), ...risingTop.map((h) => h.label)];
  const near = texts.length ? await map.nearest(texts).catch(() => texts.map(() => null)) : [];
  if (topDoc?.window) await writeSubjectLines(ctx, conn, topDoc, top, near.slice(0, top.length), store);
  const risingNear = near.slice(top.length);

  if (rising) {
    result.checked.push("rising_search");
    const onMap = await map.hasWords(risingTop.map((h) => h.key)).catch(() => new Set<string>());
    const left = risingTop.map((h, i) => ({ h, subject: risingNear[i] && risingNear[i]!.sim >= NEAR_SUBJECT ? risingNear[i]!.ref : null })).filter((x) => !onMap.has(x.h.key));
    const answered = await nearQuestions(ctx, left.map((x) => ({ text: x.h.label, subjectId: x.subject })), map, deps);
    for (const h of rising.slice(ROWS_PER_RULE)) holding.add(idOf("rising_search", { topic: h.key }));
    for (const [i, { h, subject }] of left.entries()) {
      if (answered.has(i)) continue;
      result.fired.rising_search += 1;
      candidates.push({
        strength: h.strength,
        detection: {
          ...base,
          rule: "rising_search",
          key: { topic: h.key },
          label: h.label,
          subjectId: subject,
          numbers: { searchImpressions: h.impressions, searchClicks: h.clicks },
          before: { searchImpressions: h.before },
          atMost: h.atMost,
          window: { from: topics.days[r.days]!, to: last, beforeFrom: topics.days[0]!, beforeTo: topics.days[r.days - 1]! },
          // At any size, a proposed question under its nearest subject; else a Review suggestion.
          shownIn: map.atScale && subject && map.propose ? "brand_map" : "review",
        },
      });
    }
  }

  if (losing) {
    result.checked.push("losing_page");
    const hits = losing.slice(0, ROWS_PER_RULE);
    for (const h of losing.slice(ROWS_PER_RULE)) holding.add(idOf("losing_page", { page: h.label, host: h.host ?? "" }));
    const ga4 = await landingSessions(ctx, others, hits.map((h) => h.label), pages.days[0]!, pages.days[l.days]!, last, store);
    for (const h of hits) {
      result.fired.losing_page += 1;
      const g = ga4?.get(h.label);
      candidates.push({
        strength: h.strength,
        detection: {
          ...base,
          rule: "losing_page",
          key: { page: h.label, host: h.host ?? "" },
          label: h.label,
          numbers: { searchClicks: h.clicks, ...(g ? { ga4Sessions: g.now } : {}) },
          before: { searchClicks: h.before, ...(g ? { ga4Sessions: g.before } : {}) },
          atMost: h.atMost,
          mayChange: g ? !g.final : false,
          window: { from: pages.days[l.days]!, to: last, beforeFrom: pages.days[0]!, beforeTo: pages.days[l.days - 1]! },
          shownIn: "review",
        },
      });
    }
  }

  if (reach && questionsDoc?.window) {
    result.checked.push("within_reach");
    const hits = reach.slice(0, ROWS_PER_RULE);
    for (const h of reach.slice(ROWS_PER_RULE)) holding.add(idOf("within_reach", { topic: topicKey(h.label) }));
    const words = await map.questionText(hits.map((h) => h.questionId)).catch(() => new Map<string, string>());
    for (const h of hits) {
      const question = words.get(h.questionId);
      if (!question) continue;
      result.fired.within_reach += 1;
      candidates.push({
        strength: h.strength,
        detection: {
          ...base,
          rule: "within_reach",
          key: { topic: topicKey(h.label) },
          label: h.label,
          questionId: h.questionId,
          question,
          subjectId: h.subjectId,
          numbers: { searchPosition: h.position, searchImpressions: h.impressions, searchClicks: h.clicks },
          window: { from: questionsDoc.window.from, to: questionsDoc.window.to },
          shownIn: "review",
        },
      });
    }
  }

  // Rows, then actions within the caps, strongest first.
  candidates.sort((a, b) => b.strength - a.strength);
  const open = await openConnectorSuggestions(ctx, store);
  const openIds = new Set<string>(open.map((a) => a.id));
  const todayStart = `${todayIn(now, "UTC")}T00:00:00.000Z`;
  let budget = Math.max(0, Math.min(CAPS.newPerDay - open.filter((a) => a.createdAt >= todayStart).length, CAPS.open - open.length));
  const fired = new Set<string>();
  for (const cand of candidates) {
    const { row, quiet } = await saveDetection(ctx, cand.detection, store);
    fired.add(row.id);
    if (quiet) continue;
    if (row.agentActionId && openIds.has(row.agentActionId)) {
      result.refreshed += 1;
      continue;
    }
    if (row.shownIn === "brand_map") {
      // A question it proposed is still on the map (proposed, edited, decided or dismissed): never again.
      if (row.questionId && (await map.questionExists?.(row.questionId))) continue;
      if (budget <= 0) continue;
      if (await proposeQuestion(ctx, row, cand.detection, map, now, deps)) {
        budget -= 1;
        result.proposed += 1;
      }
      continue;
    }
    if (budget <= 0) continue;
    if (await proposeSuggestion(ctx, row, cand.detection, now, deps)) {
      budget -= 1;
      result.proposed += 1;
    }
  }

  // An open Review suggestion from this connection whose rule was checked and no longer holds.
  const at = now.toISOString();
  for (const a of open.filter((x) => x.action === DATA_SIGNAL_ACTION && x.target.type === "data_signal" && !fired.has(x.target.id) && !holding.has(x.target.id))) {
    const row = await getSignal(ctx, a.target.id, store);
    if (!row || row.connectionId !== conn.id || !result.checked.includes(row.rule)) continue;
    if (await setStale(ctx, a, at, deps)) result.stale += 1;
  }
  return result;
}

/**
 * Which rising searches a question on the map already answers by meaning: each search against its
 * nearest subject's questions, in one embedding call; by shared words when meaning can't be had.
 */
async function nearQuestions(ctx: TenantContext, searches: Array<{ text: string; subjectId: string | null }>, map: MapView, deps: DetectDeps): Promise<Set<number>> {
  const out = new Set<number>();
  if (!searches.length) return out;
  const bySubject = new Map<string, string[]>();
  for (const s of searches) if (s.subjectId && !bySubject.has(s.subjectId)) bySubject.set(s.subjectId, await map.questionsOf(s.subjectId).catch(() => []));
  const questions = [...new Set([...bySubject.values()].flat())];
  if (!questions.length) return out;
  const vectors = await (deps.embed ?? embedDocuments)([...searches.map((s) => ({ content: s.text, title: "Question" })), ...questions.map((q) => ({ content: q, title: "Question" }))], ctx.region).catch(() => null);
  const vectorOf = new Map(questions.map((q, i) => [q, vectors?.[searches.length + i] ?? null] as const));
  searches.forEach((s, i) => {
    const mine = s.subjectId ? (bySubject.get(s.subjectId) ?? []) : questions;
    const v = vectors?.[i] ?? null;
    const near = mine.some((q) => {
      const qv = vectorOf.get(q);
      return v && qv ? cosine(v, qv) >= NEAR_QUESTION : nearByWords(s.text, q);
    });
    if (near) out.add(i);
  });
  return out;
}

/**
 * Search Console's subject planning doc: for each decided subject, how many of the top 100
 * searches of the 28 days sit nearest it, with their impressions and clicks. Written even when none
 * do, so a reader knows it was looked at.
 */
async function writeSubjectLines(
  ctx: TenantContext,
  conn: DataConnection,
  doc: MetricSnapshot,
  top: SnapshotRow[],
  near: Array<{ ref: string; sim: number } | null>,
  deps: { db?: FirestoreLike; now: Date },
): Promise<void> {
  const by = new Map<string, Record<string, number>>();
  const cut = new Map<string, number>();
  top.forEach((row, i) => {
    const n = near[i];
    if (!n || n.sim < NEAR_SUBJECT) return;
    const m = by.get(n.ref) ?? { nearbySearches: 0, searchImpressions: 0, searchClicks: 0 };
    m.nearbySearches! += 1;
    m.searchImpressions! += row.m.searchImpressions ?? 0;
    m.searchClicks! += row.m.searchClicks ?? 0;
    by.set(n.ref, m);
    // A search that fell under a day's cut makes the subject's sums a lower bound.
    if ((row.cutDays ?? 0) > 0) cut.set(n.ref, (cut.get(n.ref) ?? 0) + 1);
  });
  const rows: SnapshotRow[] = [...by.entries()].map(([key, m]) => ({ key, m, ...(cut.get(key) ? { cutDays: cut.get(key)! } : {}) })).sort((a, b) => (b.m.searchImpressions ?? 0) - (a.m.searchImpressions ?? 0) || a.key.localeCompare(b.key));
  await putSnapshot(
    ctx,
    planningId(conn.id, conn.collect!.gen, SEARCH_STREAM, "subject"),
    {
      connectionId: conn.id,
      gen: conn.collect!.gen,
      account: conn.account,
      connectorId: conn.connectorId,
      stream: SEARCH_STREAM,
      by: "subject",
      day: null,
      window: doc.window,
      days: doc.days,
      timeZone: doc.timeZone,
      final: true,
      totals: null,
      rows,
      rowsSeen: rows.length,
      rowsDropped: 0,
      more: false,
      floor: null,
      basis: null,
      notes: [],
      collectedAt: deps.now.toISOString(),
      ttlAt: ttlFor(doc.window!.to, SEARCH_KEEP_DAYS),
    },
    deps,
  );
}

/**
 * A page's Google Analytics sessions as a landing page, in the same days, from a connection both
 * members and Vizzy may read: the 28 days before and the last 28. Null when no such connection has
 * every one of those days collected.
 */
async function landingSessions(
  ctx: TenantContext,
  others: readonly DataConnection[],
  paths: string[],
  from: string,
  split: string,
  to: string,
  deps: { db?: FirestoreLike; now: Date },
): Promise<Map<string, { before: number; now: number; final: boolean }> | null> {
  if (!paths.length) return null;
  const stream = ga4Manifest.produces.find((p) => p.collect)?.stream;
  const ga4 = others.find((o) => o.connectorId === ga4Manifest.id && o.status === "connected" && feedsPlanning(o.grants) && o.collect?.lastDay && o.collect.lastDay >= to && (o.collect.backfilledTo ?? "9999") <= from);
  if (!ga4 || !stream) return null;
  const wanted = new Set(paths);
  const out = new Map<string, { before: number; now: number; final: boolean }>();
  let days = 0;
  let final = true;
  await readDayDocs(ctx, { id: ga4.id, gen: ga4.collect!.gen }, stream, "landing", from, to, {
    ...deps,
    each: (doc) => {
      days += 1;
      if (!doc.final) final = false;
      for (const row of doc.rows) {
        if (!wanted.has(row.key)) continue;
        const acc = out.get(row.key) ?? { before: 0, now: 0, final: true };
        if ((doc.day ?? "") < split) acc.before += row.m.ga4Sessions ?? 0;
        else acc.now += row.m.ga4Sessions ?? 0;
        out.set(row.key, acc);
      }
    },
  });
  if (days < daysIn(from, to)) return null;
  for (const v of out.values()) v.final = final;
  return out;
}
