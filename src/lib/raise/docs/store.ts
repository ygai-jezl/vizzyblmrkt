import { z } from "zod";
import { forTenant } from "@/lib/tenant";
import { TenantIsolationError } from "@/lib/tenant/errors";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { kindLabel } from "./outlines";
import { indexDeckAfterSave, removeDeckAfterDelete, type SearchableDeck } from "./search";
import { talkSeconds, wordsOf } from "./text";
import {
  RAISE_DOC_LIMITS as L,
  SUMMARY_FIELDS,
  SlideSchema,
  isRaiseDocId,
  newId,
  parseRaiseDoc,
  type DeckAudience,
  type DeckChange,
  type DeckStage,
  type DeckVersion,
  type OutlineId,
  type PackLine,
  type RaiseDoc,
  type RaiseDocSummary,
  type Slide,
} from "./types";
import { NOTE_WORDS } from "./words";

/**
 * The raise_docs store, through forTenant(ctx).raiseDocs only. Every change is a new version with a
 * note, never an overwrite: a save names the version it was made from and is refused as stale when
 * the deck has moved on. Each deck keeps version 1 and the newest 11 whole, inside its own
 * document and under 700 KB, and a line for every version ever in `changes`. Lists read a
 * projection and sort in memory, so no composite index is needed.
 */

export type RaiseResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; version?: number; issues?: string[] };

export interface StoreDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

const repoOf = (ctx: TenantContext, deps: StoreDeps) => forTenant(ctx, deps.db).raiseDocs;
const nowOf = (deps: StoreDeps) => (deps.now?.() ?? new Date()).toISOString();
const fail = (status: number, error: string, version?: number): RaiseResult<never> => ({ ok: false, status, error, ...(version !== undefined ? { version } : {}) });

/** The counts a list shows, worked out from the slides. */
export function deckTotals(slides: readonly Slide[]): { slideCount: number; words: number; talkSeconds: number } {
  const words = slides.reduce((n, s) => n + wordsOf(s), 0);
  return { slideCount: slides.length, words, talkSeconds: talkSeconds(words) };
}

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Version 1 and the newest 11 kept whole; then, while the deck is over its byte budget, the oldest
 * kept version after version 1 goes. Dropped versions keep their line in `changes`. Pure.
 */
export function trimVersions(versions: readonly DeckVersion[], rest: Record<string, unknown> = {}): DeckVersion[] {
  const sorted = [...versions].sort((a, b) => a.n - b.n);
  const first = sorted[0];
  let kept = first ? [first, ...sorted.slice(1).slice(-(L.versionsKept - 1))] : [];
  while (kept.length > 2 && bytesOf({ ...rest, versions: kept }) > L.bytes) kept = [kept[0]!, ...kept.slice(2)];
  return kept;
}

const andList = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const FIELD_WORDS: Array<[keyof Slide, string]> = [
  ["section", "section"],
  ["layout", "layout"],
  ["headline", "headline"],
  ["points", "points"],
  ["compare", "columns"],
  ["people", "people"],
  ["blocks", "numbers"],
  ["notes", "notes"],
  ["needs", "needs"],
];

/** The change note the server writes when nobody typed one: "Changed slide 3 headline and slide 5 notes." Pure. */
export function changeNote(before: { title: string; slides: readonly Slide[] }, after: { title: string; slides: readonly Slide[] }): string {
  const was = new Map(before.slides.map((s, i) => [s.id, { s, i }]));
  const now = new Set(after.slides.map((s) => s.id));
  const changed: string[] = [];
  if (before.title !== after.title) changed.push("the deck name");
  const added: number[] = [];
  for (const [i, s] of after.slides.entries()) {
    const old = was.get(s.id);
    if (!old) {
      added.push(i + 1);
      continue;
    }
    const fields = FIELD_WORDS.filter(([k]) => !same(old.s[k], s[k])).map(([, w]) => w);
    if (fields.length) changed.push(`slide ${i + 1} ${andList(fields)}`);
  }
  const removed = before.slides.flatMap((s, i) => (now.has(s.id) ? [] : [i + 1]));
  const order = (list: readonly Slide[]) => list.filter((s) => was.has(s.id) && now.has(s.id)).map((s) => s.id).join(",");
  const moved = order(before.slides) !== order(after.slides);

  const sentences: string[] = [];
  if (changed.length) sentences.push(`Changed ${andList(changed)}.`);
  if (added.length) sentences.push(`Added ${added.length === 1 ? "slide" : "slides"} ${andList(added.map(String))}.`);
  if (removed.length) sentences.push(`Removed ${removed.length === 1 ? "slide" : "slides"} ${andList(removed.map(String))}.`);
  if (moved) sentences.push("Moved slides.");
  const note = sentences.join(" ") || NOTE_WORDS.unchanged;
  if (note.length <= L.note) return note;
  const touched = new Set([...changed.filter((c) => c.startsWith("slide")), ...added, ...removed]).size;
  return `Changed ${touched} slides.`;
}

/** Whether two versions say the same (Vizzy's originals aside). */
export function sameDeck(a: { title: string; slides: readonly Slide[] }, b: { title: string; slides: readonly Slide[] }): boolean {
  const strip = (slides: readonly Slide[]) => slides.map(({ ai: _ai, ...s }) => s);
  return a.title === b.title && same(strip(a.slides), strip(b.slides));
}

interface NextVersion {
  title: string;
  slides: Slide[];
  note: string;
  by: string;
  at: string;
  /** The deck's context lines, when a revise read new ones (only ever added to, so older slides' ids still hold). */
  sources?: PackLine[];
}

/** The deck with a new version on top: versions trimmed, its line in `changes`, the counts again. Pure. */
export function withVersion(doc: RaiseDoc, v: NextVersion): RaiseDoc {
  const n = doc.version + 1;
  const version: DeckVersion = { n, note: v.note.slice(0, L.note), by: v.by, at: v.at, title: v.title, slides: v.slides };
  const changes: DeckChange[] = [{ n, note: version.note, by: v.by, at: v.at }, ...doc.changes].slice(0, L.changes);
  const sources = v.sources ? v.sources.slice(0, L.sources) : doc.sources;
  const next: RaiseDoc = { ...doc, title: v.title, version: n, current: { title: v.title, slides: v.slides }, changes, sources, ...deckTotals(v.slides), updatedAt: v.at, updatedBy: v.by };
  const { versions: _v, ...rest } = next;
  return { ...next, versions: trimVersions([...doc.versions, version], rest) };
}

// ----- Reads -----------------------------------------------------------------------------------

const SummaryRow = z.object({
  id: z.string().refine(isRaiseDocId),
  title: z.string(),
  audience: z.enum(["investor", "lender"]),
  stage: z.enum(["pre_seed", "seed", "loan"]),
  status: z.literal("draft"),
  version: z.number().int(),
  slideCount: z.number().int(),
  talkSeconds: z.number().int(),
  updatedAt: z.string(),
});

/** The brand's decks for a list, newest first: a projection, never the versions. */
export async function listRaiseDocs(ctx: TenantContext, deps: StoreDeps = {}): Promise<RaiseDocSummary[]> {
  const rows = await repoOf(ctx, deps).find({ limit: L.decks + 10, select: [...SUMMARY_FIELDS] });
  return rows
    .flatMap((r) => {
      const p = SummaryRow.safeParse(r);
      if (!p.success) return [];
      const d = p.data;
      return [{ id: d.id, title: d.title, audience: d.audience, stage: d.stage, kindLabel: kindLabel(d.audience, d.stage), status: d.status, version: d.version, slideCount: d.slideCount, talkSeconds: d.talkSeconds, updatedAt: d.updatedAt }];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

const SearchRow = z.object({
  id: z.string().refine(isRaiseDocId),
  version: z.number().int().min(1),
  current: z.object({ title: z.string(), slides: z.array(SlideSchema) }),
});

/** The brand's decks for the search sweep: title, current slides and version only. */
export async function listDecksForSearch(ctx: TenantContext, deps: StoreDeps = {}): Promise<SearchableDeck[]> {
  const rows = await repoOf(ctx, deps).find({ limit: L.decks + 10, select: ["title", "current", "version"] });
  return rows.flatMap((r) => {
    const p = SearchRow.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

export async function countRaiseDocs(ctx: TenantContext, deps: StoreDeps = {}): Promise<number> {
  return repoOf(ctx, deps).count();
}

/** One deck by id, or null when it isn't this brand's or can't be read. */
export async function readRaiseDoc(ctx: TenantContext, id: string, deps: StoreDeps = {}): Promise<RaiseDoc | null> {
  if (!isRaiseDocId(id)) return null;
  return parseRaiseDoc(await repoOf(ctx, deps).getById(id));
}

// ----- Writes ----------------------------------------------------------------------------------

export interface NewDeck {
  audience: DeckAudience;
  stage: DeckStage;
  title: string;
  slides: Slide[];
  sources: PackLine[];
  outline: OutlineId;
  made?: RaiseDoc["made"];
  /** "vizzy" or the person's user id. */
  by: string;
  note: string;
}

/** Version 1 of a new deck. Refused at 20 decks. */
export async function createRaiseDoc(ctx: TenantContext, input: NewDeck, deps: StoreDeps = {}): Promise<RaiseResult<RaiseDoc>> {
  const repo = repoOf(ctx, deps);
  if ((await repo.count()) >= L.decks) return fail(409, "deck_limit");
  const at = nowOf(deps);
  const title = input.title.trim().slice(0, L.title) || "Untitled deck";
  const creator = ctx.userId ?? input.by;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = newId("rd");
    const doc: RaiseDoc = {
      id,
      tenantId: ctx.tenantId,
      kind: "deck",
      audience: input.audience,
      stage: input.stage,
      title,
      status: "draft",
      version: 1,
      current: { title, slides: input.slides },
      versions: [{ n: 1, note: input.note.slice(0, L.note), by: input.by, at, title, slides: input.slides }],
      changes: [{ n: 1, note: input.note.slice(0, L.note), by: input.by, at }],
      sources: input.sources.slice(0, L.sources),
      outline: { id: input.outline, version: 1 },
      ...(input.made ? { made: input.made } : {}),
      ...deckTotals(input.slides),
      createdAt: at,
      createdBy: creator,
      updatedAt: at,
      updatedBy: input.by,
    };
    const parsed = parseRaiseDoc(doc);
    if (!parsed) return fail(400, "invalid_deck");
    try {
      const { id: _i, tenantId: _t, ...data } = parsed;
      await repo.create(id, data);
    } catch (err) {
      if (err instanceof TenantIsolationError) continue;
      throw err;
    }
    indexDeckAfterSave(ctx, parsed);
    return { ok: true, value: parsed };
  }
  return fail(500, "id_collision");
}

export interface VersionInput {
  /** The version the change was made from. */
  baseVersion: number;
  title?: string;
  slides: Slide[];
  /** The person's note, or Vizzy's; without one the server writes it from the difference. */
  note?: string;
  /** "vizzy" or the person's user id. */
  by: string;
  /**
   * Keep each slide's AI original as stored (default): a person's edit never writes it. Vizzy's
   * revise passes false and sets `ai` itself on the slides it wrote.
   */
  keepAi?: boolean;
  /** The deck's context lines after a revise read new ones; left out, they stay as they are. */
  sources?: PackLine[];
}

export interface Saved {
  doc: RaiseDoc;
  /** False when nothing changed: no new version was made. */
  saved: boolean;
}

/** Save a new version on top of `baseVersion`, in one transaction. Stale is a 409 with the stored version. */
export async function saveRaiseVersion(ctx: TenantContext, id: string, input: VersionInput, deps: StoreDeps = {}): Promise<RaiseResult<Saved>> {
  if (!isRaiseDocId(id)) return fail(404, "not_found");
  // Set inside the transaction (which may run more than once), read after it.
  let outcome = fail(404, "not_found") as RaiseResult<Saved>;
  const at = nowOf(deps);
  const written = await repoOf(ctx, deps).claim(id, (raw) => {
    const doc = parseRaiseDoc(raw);
    if (!doc) {
      outcome = fail(500, "unreadable");
      return null;
    }
    if (doc.version !== input.baseVersion) {
      outcome = fail(409, "stale_version", doc.version);
      return null;
    }
    const stored = new Map(doc.current.slides.map((s) => [s.id, s.ai]));
    const slides = input.keepAi === false ? input.slides : input.slides.map(({ ai: _ai, ...s }) => (stored.get(s.id) ? { ...s, ai: stored.get(s.id)! } : s));
    const title = (input.title ?? doc.title).trim().slice(0, L.title) || doc.title;
    if (sameDeck(doc.current, { title, slides })) {
      outcome = { ok: true, value: { doc, saved: false } };
      return null;
    }
    const note = input.note?.trim() || changeNote(doc.current, { title, slides });
    const next = withVersion(doc, { title, slides, note, by: input.by, at, ...(input.sources ? { sources: input.sources } : {}) });
    if (!parseRaiseDoc(next)) {
      outcome = fail(400, "invalid_deck");
      return null;
    }
    outcome = { ok: true, value: { doc: next, saved: true } };
    const { id: _i, tenantId: _t, createdAt: _c, ...patch } = next;
    return patch;
  });
  if (written && outcome.ok) indexDeckAfterSave(ctx, outcome.value.doc);
  return outcome;
}

/** Put a kept version back as a new version, note "Put back version n." */
export async function restoreRaiseVersion(ctx: TenantContext, id: string, input: { n: number; baseVersion: number; by: string }, deps: StoreDeps = {}): Promise<RaiseResult<Saved>> {
  const doc = await readRaiseDoc(ctx, id, deps);
  if (!doc) return fail(404, "not_found");
  const kept = doc.versions.find((v) => v.n === input.n);
  if (!kept) return fail(404, "version_not_kept");
  return saveRaiseVersion(ctx, id, { baseVersion: input.baseVersion, title: kept.title, slides: kept.slides, note: NOTE_WORDS.putBack(input.n), by: input.by, keepAi: false }, deps);
}

/** Delete the deck and every version (they live in its document), and take it out of search. The erase path. */
export async function deleteRaiseDoc(ctx: TenantContext, id: string, deps: StoreDeps = {}): Promise<boolean> {
  if (!isRaiseDocId(id)) return false;
  const repo = repoOf(ctx, deps);
  if (!(await repo.getById(id))) return false;
  await repo.delete(id);
  removeDeckAfterDelete(ctx, id);
  return true;
}

export interface DeckExport {
  exportedAt: string;
  deck: Pick<RaiseDoc, "id" | "title" | "audience" | "stage" | "version" | "current" | "versions" | "changes" | "sources">;
}

/** The deck and its kept versions as data, for Download data. The export path. */
export async function exportRaiseDoc(ctx: TenantContext, id: string, deps: StoreDeps = {}): Promise<DeckExport | null> {
  const doc = await readRaiseDoc(ctx, id, deps);
  if (!doc) return null;
  const { title, audience, stage, version, current, versions, changes, sources } = doc;
  return { exportedAt: nowOf(deps), deck: { id: doc.id, title, audience, stage, version, current, versions, changes, sources } };
}
