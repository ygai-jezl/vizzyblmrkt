import { brandMapRecords, type BrandMapRecordStore } from "@/lib/tenant/brandMapRecords";
import { removeBrandMapVector } from "@/lib/tenant/brandMapVectors";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { QuestionState } from "@/lib/content/blog/coverage";
import type { BlogIntent } from "@/lib/types/contentPlan";
import {
  BRAND_MAP_RECORD_LIMITS as LIMITS,
  BrandMapSituationSchema,
  type BrandMapSituation,
  type BrandMapStoredRecord,
  type RecordFrom,
  type RecordStatus,
  type SituationSide,
  type SituationW,
} from "@/lib/types/brandMapRecords";
import { embedSituations, type EmbedDeps } from "./embed";
import { createOnce } from "./createOnce";
import { freshId, situationIdFor, situationKey } from "./keys";
import { markRecordsDecided, parseQuestion, parseSubject, type RecordResult } from "./records";

/**
 * A brand's buying situations (BRAND_MAP_SITUATIONS_ENABLED): the situations people are in
 * when they look for something like it, in their own words, each with the W behind it (why,
 * when, while, with whom, with what, how it feels), who they are, what they want, and the
 * questions they ask — Ehrenberg-Bass's category entry points. A situation sits beside the
 * subjects, joined through its questions (`situationIds` on a question). A person stars the
 * ones to focus on, with no limit. Each record has its own revision; a stale edit is refused
 * with the record as it is now.
 */

type Deps = { db?: FirestoreLike; nowMs?: number; embed?: Omit<EmbedDeps, "db" | "nowMs"> };

const iso = (nowMs?: number) => new Date(nowMs ?? Date.now()).toISOString();
const fail = (status: number, error: string, current?: unknown): RecordResult<never> => ({ ok: false, status, error, ...(current ? { current } : {}) });
const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function parseSituation(raw: BrandMapStoredRecord | null): BrandMapSituation | null {
  if (!raw) return null;
  const r = BrandMapSituationSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** A brand's buying situations, focus first, then in their order. A dismissed one is kept (so research doesn't propose it again) but not listed. */
export async function listSituations(ctx: TenantContext, deps: Deps = {}): Promise<BrandMapSituation[]> {
  const rows = await brandMapRecords(ctx, deps.db).pageAll("sit");
  return rows
    .flatMap((r) => parseSituation(r) ?? [])
    .filter((s) => s.status !== "dismissed")
    .sort((a, b) => Number(b.focus) - Number(a.focus) || a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export interface SituationInput {
  text: string;
  w?: SituationW;
  wText?: string;
  who?: string;
  side?: SituationSide;
  want?: string;
  feel?: string;
}

const parts = (input: Partial<SituationInput>) => ({
  ...(input.w ? { w: input.w } : {}),
  ...(input.wText !== undefined ? { wText: clip(input.wText, LIMITS.situationPart) } : {}),
  ...(input.who !== undefined ? { who: clip(input.who, LIMITS.situationPart) } : {}),
  ...(input.side ? { side: input.side } : {}),
  ...(input.want !== undefined ? { want: clip(input.want, LIMITS.situationPart) } : {}),
  ...(input.feel !== undefined ? { feel: clip(input.feel, LIMITS.situationPart) } : {}),
});

/** Its meaning, for the nearest lookups (best effort: never fails the change). */
async function embedOne(ctx: TenantContext, s: BrandMapSituation | null, deps: Deps): Promise<void> {
  if (s) await embedSituations(ctx, [s], { db: deps.db, ...deps.embed }).catch(() => 0);
}

/** A person adds a situation: decided at once. One dismissed before comes back. */
export async function createSituation(ctx: TenantContext, input: SituationInput, deps: Deps = {}): Promise<RecordResult<BrandMapSituation>> {
  const now = iso(deps.nowMs);
  const store = brandMapRecords(ctx, deps.db);
  const text = clip(input.text, LIMITS.situationText);
  const key = situationKey(text);
  if (!key) return fail(400, "invalid_situation");
  const [existing] = await store.find("sit", { where: [["textKey", "==", key]], limit: 1 });
  if (existing && existing.status !== "dismissed") return fail(409, "situation_exists", parseSituation(existing));
  const count = await store.count("sit");
  if (!existing && count >= LIMITS.situations) return fail(409, "too_many_situations");
  const parsed = BrandMapSituationSchema.safeParse({
    id: existing?.id ?? situationIdFor(ctx.tenantId, text),
    tenantId: ctx.tenantId,
    status: "decided",
    from: "person",
    rev: 0,
    createdAt: now,
    updatedAt: now,
    decidedAt: now,
    text,
    textKey: key,
    order: count,
    ...parts(input),
  });
  if (!parsed.success) return fail(400, "invalid_situation");
  const { id, tenantId: _t, ...data } = parsed.data;
  void _t;
  let saved;
  if (existing) saved = await store.claim("sit", existing.id, (cur) => ({ ...data, rev: Number(cur.rev ?? 0) + 1, createdAt: cur.createdAt }));
  else {
    const once = await createOnce(store, "sit", id, data, { same: (there) => there.textKey === key, fresh: () => freshId("sit") });
    // Added by someone else at the same moment: it's on the map already.
    if (once.existing) return fail(409, "situation_exists", parseSituation(once.existing));
    saved = once.created;
  }
  await markRecordsDecided(ctx, deps);
  const value = parseSituation(saved);
  await embedOne(ctx, value, deps);
  return value ? { ok: true, value, touched: [] } : fail(500, "not_saved");
}

/**
 * A situation proposed (Vizzy, on a person's word): waiting for a person, never on the map by
 * itself. One the map has is not proposed again; one a person dismissed comes back only when
 * someone asked for it outright (`revive`).
 */
export async function proposeSituation(
  ctx: TenantContext,
  input: SituationInput,
  opts: { from: RecordFrom; reason: string; revive?: boolean },
  deps: Deps = {},
): Promise<BrandMapSituation | null> {
  const now = iso(deps.nowMs);
  const store = brandMapRecords(ctx, deps.db);
  const text = clip(input.text, LIMITS.situationText);
  const key = situationKey(text);
  if (!key) return null;
  const [found] = await store.find("sit", { where: [["textKey", "==", key]], limit: 1 });
  if (found) {
    if (found.status !== "dismissed" || !opts.revive) return null;
    const back = parseSituation(await store.claim("sit", found.id, (cur) => ({ status: "proposed", from: opts.from, reason: clip(opts.reason, 200), rev: Number(cur.rev ?? 0) + 1, updatedAt: now })));
    await embedOne(ctx, back, deps);
    return back;
  }
  const count = await store.count("sit");
  if (count >= LIMITS.situations) return null;
  const parsed = BrandMapSituationSchema.safeParse({
    id: situationIdFor(ctx.tenantId, text),
    tenantId: ctx.tenantId,
    status: "proposed",
    from: opts.from,
    reason: clip(opts.reason, 200),
    rev: 0,
    createdAt: now,
    updatedAt: now,
    text,
    textKey: key,
    order: count,
    ...parts(input),
  });
  if (!parsed.success) return null;
  const { id, tenantId: _t, ...data } = parsed.data;
  void _t;
  const once = await createOnce(store, "sit", id, data, { same: (there) => there.textKey === key, fresh: () => freshId("sit") });
  // Proposed at the same moment by another step: not proposed twice.
  if (once.existing) return null;
  const saved = parseSituation(once.created);
  await embedOne(ctx, saved, deps);
  return saved;
}

/** A person edits a situation, naming the revision they started from; `focus` stars it. */
export async function editSituation(
  ctx: TenantContext,
  id: string,
  input: Partial<SituationInput> & { baseRev: number; focus?: boolean },
  deps: Deps = {},
): Promise<RecordResult<BrandMapSituation>> {
  const now = iso(deps.nowMs);
  const store = brandMapRecords(ctx, deps.db);
  const text = input.text !== undefined ? clip(input.text, LIMITS.situationText) : undefined;
  const key = text !== undefined ? situationKey(text) : undefined;
  if (key === "") return fail(400, "invalid_situation");
  if (key) {
    const [other] = await store.find("sit", { where: [["textKey", "==", key]], limit: 2 });
    if (other && other.id !== id && other.status !== "dismissed") return fail(409, "situation_exists", parseSituation(other));
  }
  const seen: { conflict: BrandMapSituation | null } = { conflict: null };
  const saved = await store.claim("sit", id, (cur) => {
    const current = parseSituation(cur);
    if (!current) return null;
    if (current.rev !== input.baseRev) {
      seen.conflict = current;
      return null;
    }
    return {
      ...(text !== undefined ? { text, textKey: key } : {}),
      ...parts(input),
      ...(input.focus !== undefined ? { focus: input.focus } : {}),
      rev: current.rev + 1,
      updatedAt: now,
    };
  });
  if (seen.conflict) return fail(409, "record_changed", seen.conflict);
  const value = parseSituation(saved);
  if (!value) return fail(404, "no_situation");
  // Its words changed: so did its meaning.
  if (text !== undefined || input.want !== undefined || input.who !== undefined) await embedOne(ctx, value, deps);
  return { ok: true, value, touched: [] };
}

/** The questions linked to a situation (decided and proposed), a page at a time. */
const linkedQuestions = (store: BrandMapRecordStore, id: string) => store.pageAll("q", { where: [["situationIds", "array-contains", id]] });

/** Remove a situation: its questions stay on their subjects, no longer linked to it. */
export async function removeSituation(ctx: TenantContext, id: string, deps: Deps = {}): Promise<RecordResult<{ id: string; questions: number }>> {
  const store = brandMapRecords(ctx, deps.db);
  if (!parseSituation(await store.get("sit", id))) return fail(404, "no_situation");
  const linked = await linkedQuestions(store, id);
  for (const q of linked) {
    await store
      .claim("q", q.id, (cur) => {
        const ids = Array.isArray(cur.situationIds) ? (cur.situationIds as string[]) : [];
        return ids.includes(id) ? { situationIds: ids.filter((x) => x !== id) } : null;
      })
      .catch(() => null);
  }
  await store.remove("sit", id);
  await removeBrandMapVector(ctx, "situation", id, deps.db).catch(() => undefined);
  return { ok: true, value: { id, questions: linked.length }, touched: [] };
}

/** A question of a situation as its page shows it: which subject it is on, and how far along. */
export interface SituationQuestion {
  id: string;
  text: string;
  intent: BlogIntent;
  status: RecordStatus;
  subjectId: string;
  subjectName: string;
  /** Its subject is still a proposal: adding the question adds the subject too. */
  newSubject: boolean;
  state: QuestionState;
}

export interface SituationRead {
  situation: BrandMapSituation;
  questions: SituationQuestion[];
}

/**
 * One situation with its questions, each with its subject and how far along it is (from the
 * subject's own lists, kept as pages change). Reading it also brings its stored counts up to
 * date (display only: never a new revision).
 */
export async function readSituation(ctx: TenantContext, id: string, deps: Deps = {}): Promise<SituationRead | null> {
  const store = brandMapRecords(ctx, deps.db);
  const situation = parseSituation(await store.get("sit", id));
  if (!situation) return null;
  const questions = (await linkedQuestions(store, id)).flatMap((r) => {
    const q = parseQuestion(r);
    return q && q.status !== "dismissed" ? [q] : [];
  });
  const subjects = new Map(
    (await store.getMany("sub", [...new Set(questions.map((q) => q.subjectId))])).flatMap((r) => {
      const s = parseSubject(r);
      return s ? [[s.id, s] as const] : [];
    }),
  );
  const stateOf = (qid: string, sid: string): QuestionState => {
    const s = subjects.get(sid);
    if (!s) return "open";
    return s.answeredIds.includes(qid) ? "answered" : s.draftedIds.includes(qid) ? "drafted" : s.plannedIds.includes(qid) ? "planned" : "open";
  };
  const shown = questions
    .map((q) => ({
      id: q.id,
      text: q.text,
      intent: q.intent,
      status: q.status,
      subjectId: q.subjectId,
      subjectName: subjects.get(q.subjectId)?.name ?? "",
      newSubject: subjects.get(q.subjectId)?.status === "proposed",
      state: stateOf(q.id, q.subjectId),
    }))
    .sort((a, b) => Number(a.status === "proposed") - Number(b.status === "proposed") || a.text.localeCompare(b.text));
  const decided = shown.filter((q) => q.status === "decided");
  const counts = { questions: decided.length, answered: decided.filter((q) => q.state === "answered").length };
  if (counts.questions !== situation.counts.questions || counts.answered !== situation.counts.answered) {
    await store.claim("sit", id, () => ({ counts })).catch(() => null);
  }
  return { situation: { ...situation, counts }, questions: shown };
}

/** Bring these situations' stored counts up to date (after their questions changed): a few at a time, best effort. */
export async function recountSituations(ctx: TenantContext, ids: Iterable<string>, deps: Deps = {}): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 5) {
    await Promise.all(unique.slice(i, i + 5).map((id) => readSituation(ctx, id, deps).catch(() => null)));
  }
}
