import type { BrandNote } from "@/lib/types/brandNote";
import type { Competitor, CompetitorArticle } from "@/lib/types/competitor";
import { CHUNK_CHARS } from "./text";
import type { SearchKind, SearchSource, SearchStatus } from "./types";

/**
 * The brand map family (ADR-0025): what brand_map_vectors holds, kept in brand search for every
 * brand while SEARCH_FAMILY_INDEX_ENABLED is on, so the readers that match by meaning can move to
 * gemini-embedding-001 before text-embedding-005 retires. Subjects and situations (decided or
 * proposed), kept notes, the questions asked of the team (asked or answered) and competitor
 * articles. The brand map's own questions and competitors' summaries share two of these kinds but
 * stay for brands granted brand_search only.
 *
 * Pure: no store, so the indexer, the feeders, write-through and the readers can all share it
 * (the feeders read the whole brand, and importing them from a writer would go round in a circle).
 */

/** The kinds the family is kept under. */
export const FAMILY_KINDS = ["subject", "situation", "note", "question", "competitor"] as const satisfies readonly SearchKind[];

/** An open question's ref in the index: its note's id after this (a brand map question's id starts `q_`). */
export const NOTE_QUESTION_PREFIX = "note_";

export const noteQuestionRef = (noteId: string): string => `${NOTE_QUESTION_PREFIX}${noteId}`;

/** The note an open question's ref names, or null for a brand map question. */
export function noteIdOfQuestionRef(ref: string): string | null {
  return ref.startsWith(NOTE_QUESTION_PREFIX) && ref.length > NOTE_QUESTION_PREFIX.length ? ref.slice(NOTE_QUESTION_PREFIX.length) : null;
}

/** A competitor article's ref in the index. A competitor's own summary is its id alone, with no slash. */
export const competitorArticleRef = (competitorId: string, articleId: string): string => `${competitorId}/${articleId}`;

/** The article a competitor ref names, or null for a competitor's summary. */
export function articleIdOfRef(ref: string): string | null {
  const at = ref.indexOf("/");
  return at > 0 && at < ref.length - 1 ? ref.slice(at + 1) : null;
}

/** Whether a record is one of the family every brand keeps (not a brand map question or a competitor's summary). */
export function isFamilyRecord(kind: SearchKind, ref: string): boolean {
  if (kind === "subject" || kind === "situation" || kind === "note") return true;
  if (kind === "question") return noteIdOfQuestionRef(ref) !== null;
  if (kind === "competitor") return articleIdOfRef(ref) !== null;
  return false;
}

/** A cut-off measured on each model: `old` for text-embedding-005 (brand_map_vectors), `new` for gemini-embedding-001 (brand search). */
export interface CutOff {
  old: number;
  new: number;
}

/** The cut-off for the store a reader uses now. */
export const cutOff = (pair: CutOff, onIndex: boolean): number => (onIndex ? pair.new : pair.old);

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const lines = (...parts: Array<string | null | undefined | false>) => parts.filter((p): p is string => Boolean(p && p.trim())).join("\n\n");

// ── The family's records as search sources (pure) ─────────────────────────────────────────

const MAP_URL = "/admin/brand-kit/map";

/** A brand map record as stored: its own id (`ref`) and its fields. */
type MapRecord = { ref: string } & Record<string, unknown>;

/** How many of a subject's questions its text carries, as brand_map_vectors did. */
export const SUBJECT_QUESTIONS = 10;

/** A record on the map or proposed for it: its family status, or null (dismissed, merged away). */
function mapStatus(r: MapRecord): Extract<SearchStatus, "decided" | "proposed"> | null {
  if (r.mergedInto) return null;
  return r.status === "decided" || r.status === "proposed" ? r.status : null;
}

/**
 * A question a connection proposed that nobody has decided (a rising search, `from: search_console`
 * with its `fromConnectionId`). Its words are the connection's data: erasing the connection
 * withdraws it (ADR-0013) without touching its subject, so they never go into a subject's text.
 * Once a person decides it, it is theirs.
 */
const proposedByConnection = (q: Record<string, unknown>): boolean => q.status !== "decided" && (Boolean(q.fromConnectionId) || q.from === "search_console");

/**
 * A subject's first questions, as the sweep and write-through both read them: not dismissed or
 * merged away, never one a connection proposed, by their order, then when they were made, then id.
 * The first SUBJECT_QUESTIONS. With `decidedOnly`, decided ones only.
 */
export function firstQuestions(questions: ReadonlyArray<Record<string, unknown>>, opts: { decidedOnly?: boolean } = {}): string[] {
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return questions
    .filter((q) => (opts.decidedOnly ? q.status === "decided" : q.status !== "dismissed") && !q.mergedInto && !proposedByConnection(q) && s(q.text).trim())
    .sort((a, b) => num(a.order) - num(b.order) || s(a.createdAt).localeCompare(s(b.createdAt)) || s(a.id ?? a.ref).localeCompare(s(b.id ?? b.ref)))
    .slice(0, SUBJECT_QUESTIONS)
    .map((q) => s(q.text).trim());
}

/**
 * A subject as the brand map family keeps it (SEARCH_FAMILY_INDEX_ENABLED): its name, its
 * description, then its first questions, cut to one chunk so the subject has one vector, with its
 * status. A decided subject is shown to people, so its text carries decided questions only and no
 * proposal reaches people's search through it; a proposed one carries its proposed questions too,
 * so "looks like" compares it as brand_map_vectors did. The sweep and write-through both make it
 * here, so their text is the same. Null when it is dismissed or merged away.
 */
export function subjectSearchSource(r: MapRecord, questions: ReadonlyArray<Record<string, unknown>>): SearchSource | null {
  const status = mapStatus(r);
  const name = s(r.name).trim();
  if (!status || !name) return null;
  const body = lines(name, s(r.description), ...firstQuestions(questions, { decidedOnly: status === "decided" })).slice(0, CHUNK_CHARS).trim();
  return { kind: "subject", ref: r.ref, title: name, body, url: MAP_URL, status };
}

/** A buying situation as the brand map family keeps it (SEARCH_FAMILY_INDEX_ENABLED): with its status. */
export function situationSearchSource(r: MapRecord): SearchSource | null {
  const status = mapStatus(r);
  const src = status ? situationBody(r) : null;
  return src ? { ...src, status: status! } : null;
}

/** A buying situation's text as brand search keeps it: its words, who, what they want and feel, and why. */
export function situationBody(r: MapRecord): SearchSource | null {
  const text = s(r.text);
  return text
    ? { kind: "situation", ref: r.ref, title: text, body: lines(text, s(r.who) && `Who: ${s(r.who)}`, s(r.want) && `Wants: ${s(r.want)}`, s(r.feel) && `Feels: ${s(r.feel)}`, s(r.wText)), url: MAP_URL }
    : null;
}

const NOTES_URL = "/admin/brand-kit/notes";

/**
 * A What we've seen note as the family keeps it (SEARCH_FAMILY_INDEX_ENABLED): a kept note, `kept`;
 * an open question, `asked` under `note_{id}`. An answered question is a kept note AND keeps its
 * question entry, `answered`, whose text is the question only, so asking and answering moves its
 * status and embeds nothing. A note that may name a customer is never kept (decision 40): its
 * entries go.
 */
export function noteSearchSources(n: Pick<BrandNote, "id" | "text" | "status" | "canName" | "source"> & { question?: string | null }): SearchSource[] {
  if (n.canName) return [];
  const question = s(n.question).trim();
  const ask = (status: "asked" | "answered"): SearchSource => ({ kind: "question", ref: noteQuestionRef(n.id), title: question, body: question, url: NOTES_URL, status });
  if (n.status === "asked") return question ? [ask("asked")] : [];
  if (n.status !== "kept" || !n.text.trim()) return [];
  const note: SearchSource = { kind: "note", ref: n.id, title: n.text.slice(0, 120), body: lines(question && `Asked: ${question}`, n.text), url: NOTES_URL, status: "kept" };
  return n.source === "question" && question ? [note, ask("answered")] : [note];
}

/**
 * What one competitor article covers, as brand search keeps it: never its quotes or author. In the
 * family (SEARCH_FAMILY_INDEX_ENABLED) it is `kept`, so the readers find it; the competitor's own
 * summary has no status, so people find it and the readers never do. Null when there's nothing to say.
 */
export function competitorArticleSource(
  c: Pick<Competitor, "id" | "name">,
  a: Pick<CompetitorArticle, "id" | "title" | "summary" | "question" | "angle">,
  opts: { family?: boolean } = {},
): SearchSource | null {
  const body = lines(s(a.summary), s(a.question) && `Answers: ${s(a.question)}`, s(a.angle) && `Angle: ${s(a.angle)}`);
  if (!body) return null;
  return { kind: "competitor", ref: competitorArticleRef(c.id, a.id), title: `${c.name}: ${a.title}`, body, url: `/admin/brand-kit/competitors/${c.id}`, ...(opts.family ? { status: "kept" as const } : {}) };
}

