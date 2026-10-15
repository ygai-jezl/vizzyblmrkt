import { brandMapRecords, type BrandMapRecordStore, type RecordKind } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BlogIntent } from "@/lib/types/contentPlan";
import type { BrandMapStoredRecord, RecordFrom } from "@/lib/types/brandMapRecords";
import { BrandMapQuestionRecordSchema, BrandMapSubjectRecordSchema } from "@/lib/types/brandMapRecords";
import { freshId, questionIdFor, questionKey, subjectIdFor, subjectKey } from "./keys";
import { markRecordsDecided } from "./records";

/**
 * Proposing a subject or a question on the map at any size (BRAND_MAP_SCALE_ENABLED), from
 * the move, research, an import or Vizzy. A proposal waits for a person; nothing reaches an
 * article until it is decided. One already on the map, already waiting, or dismissed before
 * is never proposed again (by its key: the subject's folded name, the question's words).
 */

interface ProposeBase {
  from: RecordFrom;
  reason?: string;
  evidence?: string;
  now: string;
  /** Keys a person dismissed on the old record's list (`subject:<name>`, `q:<subject>:<text>`). */
  dismissedKeys?: Set<string>;
  /** Someone asked for it outright (Vizzy, on a person's word): one dismissed before is proposed again. */
  revive?: boolean;
}

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * The subject with this name: one already there (when `existingOk`, unless it was dismissed),
 * or a new proposal. Null when it is there and `existingOk` is off, or a person dismissed it.
 */
export async function proposedSubject(
  ctx: TenantContext,
  store: BrandMapRecordStore,
  input: ProposeBase & { name: string; groupId?: string | null; existingOk?: boolean },
): Promise<BrandMapStoredRecord | null> {
  const name = clip(input.name, 80);
  const key = subjectKey(name);
  if (!key) return null;
  const [found] = await store.find("sub", { where: [["nameKey", "==", key]], limit: 1 });
  if (found?.status === "dismissed" && input.revive && !found.mergedInto) {
    return store.claim("sub", found.id, (cur) => ({ status: "proposed", from: input.from, reason: clip(input.reason, 200), rev: Number(cur.rev ?? 0) + 1, updatedAt: input.now }));
  }
  if (found) return input.existingOk && found.status !== "dismissed" ? found : null;
  if (input.dismissedKeys?.has(`subject:${key}`) && !input.revive) return null;
  const record = BrandMapSubjectRecordSchema.parse({
    id: subjectIdFor(ctx.tenantId, name),
    tenantId: ctx.tenantId,
    status: "proposed",
    from: input.from,
    reason: clip(input.reason, 200),
    evidence: clip(input.evidence, 200),
    rev: 0,
    createdAt: input.now,
    updatedAt: input.now,
    name,
    nameKey: key,
    groupId: input.groupId ?? null,
  });
  const { id, tenantId: _t, ...data } = record;
  void _t;
  // The id comes from the name; one taken by a subject since renamed gets a fresh one.
  return (await store.createIfAbsent("sub", id, data)) ?? (await store.create("sub", freshId("sub"), data));
}

/** A question proposed for a subject. Null when the map already has it (or had it dismissed). */
export async function proposedQuestion(
  ctx: TenantContext,
  store: BrandMapRecordStore,
  input: ProposeBase & { subjectId: string; subjectName?: string; text: string; intent?: BlogIntent; situationIds?: string[]; order?: number },
): Promise<BrandMapStoredRecord | null> {
  const text = clip(input.text, 200);
  const key = questionKey(text);
  if (!key) return null;
  const [found] = await store.find("q", { where: [["textKey", "==", key]], limit: 1 });
  if (found?.status === "dismissed" && input.revive) {
    return store.claim("q", found.id, (cur) => ({ status: "proposed", subjectId: input.subjectId, from: input.from, reason: clip(input.reason, 200), rev: Number(cur.rev ?? 0) + 1, updatedAt: input.now }));
  }
  if (found) return null;
  if (input.subjectName && input.dismissedKeys?.has(`q:${subjectKey(input.subjectName)}:${subjectKey(text)}`) && !input.revive) return null;
  const record = BrandMapQuestionRecordSchema.parse({
    id: questionIdFor(ctx.tenantId, input.subjectId, text),
    tenantId: ctx.tenantId,
    status: "proposed",
    from: input.from,
    reason: clip(input.reason, 200),
    evidence: clip(input.evidence, 200),
    rev: 0,
    createdAt: input.now,
    updatedAt: input.now,
    subjectId: input.subjectId,
    text,
    textKey: key,
    intent: input.intent ?? "other",
    situationIds: input.situationIds ?? [],
    order: input.order ?? 0,
  });
  const { id, tenantId: _t, ...data } = record;
  void _t;
  return (await store.createIfAbsent("q", id, data)) ?? (await store.create("q", freshId("q"), data));
}

export interface ProposalIds {
  subjects?: string[];
  questions?: string[];
  situations?: string[];
  /** A proposed group, or a group's suggested subjects ("Sort into groups"). */
  groups?: string[];
}

const KIND: Record<keyof ProposalIds, RecordKind> = { subjects: "sub", questions: "q", situations: "sit", groups: "grp" };

async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += limit) await Promise.all(items.slice(i, i + limit).map(run));
}

/**
 * A group's suggested subjects: moved into it (`move`), or the suggestion let go. A subject a
 * person has put in a group since only loses the suggestion. Returns the subjects moved.
 */
async function answerSuggestions(store: BrandMapRecordStore, groupId: string, move: boolean, now: string): Promise<string[]> {
  const waiting = await store.pageAll("sub", { where: [["suggestedGroupId", "==", groupId]], fields: ["suggestedGroupId", "groupId"] });
  const moved: string[] = [];
  await eachLimited(waiting, 10, async (s) => {
    const done = await store.claim("sub", s.id, (cur) => {
      if (cur.suggestedGroupId !== groupId) return null;
      if (!move || cur.groupId != null) return { suggestedGroupId: null };
      return { groupId, suggestedGroupId: null, rev: Number(cur.rev ?? 0) + 1, updatedAt: now };
    });
    if (move && done?.groupId === groupId) moved.push(s.id);
  });
  await store.claim("grp", groupId, (cur) => (cur.suggested ? { suggested: 0 } : null)).catch(() => null);
  return moved;
}

/**
 * A person accepts or dismisses proposals, many at once. Accepting a question also accepts
 * the subject it is proposed for (a decided question can't sit in a proposed subject);
 * dismissing a subject dismisses the questions proposed for it. Accepting a group decides it
 * (if proposed) and moves in the subjects suggested for it; dismissing one lets those
 * suggestions go. Only proposals change status: something already decided is left as it is.
 * Returns the subjects touched, and the groups that lost one.
 */
export async function decideProposals(
  ctx: TenantContext,
  input: { accept?: ProposalIds; dismiss?: ProposalIds },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<{ accepted: number; dismissed: number; touched: string[]; groups: Array<string | null>; situations: string[] }> {
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  const store = brandMapRecords(ctx, deps.db);
  const touched = new Set<string>();
  const left = new Set<string | null>();
  // The buying situations of questions decided either way: their counts follow.
  const situations = new Set<string>();
  const noteSituations = (q: BrandMapStoredRecord | null) => {
    if (q && Array.isArray(q.situationIds)) for (const id of q.situationIds as string[]) situations.add(id);
  };
  let accepted = 0;
  let dismissed = 0;
  const set = (kind: RecordKind, id: string, status: "decided" | "dismissed") =>
    store.claim(kind, id, (cur) => {
      if (cur.status !== "proposed") return null;
      return { status, rev: Number(cur.rev ?? 0) + 1, updatedAt: now, ...(status === "decided" ? { decidedAt: now } : {}) };
    });

  const accept = input.accept ?? {};
  const questionSubjects = new Set<string>();
  await eachLimited(accept.questions ?? [], 10, async (id) => {
    const q = await set("q", id, "decided");
    noteSituations(q);
    if (q) {
      accepted += 1;
      if (typeof q.subjectId === "string") questionSubjects.add(q.subjectId);
    }
  });
  const subjects = [...new Set([...(accept.subjects ?? []), ...questionSubjects])];
  await eachLimited(subjects, 10, async (id) => {
    if (await set("sub", id, "decided")) accepted += (accept.subjects ?? []).includes(id) ? 1 : 0;
    touched.add(id);
  });
  await eachLimited(accept.situations ?? [], 10, async (id) => {
    if (await set(KIND.situations, id, "decided")) accepted += 1;
    situations.add(id);
  });
  for (const id of new Set(accept.groups ?? [])) {
    const group = await store.get(KIND.groups, id);
    if (!group || group.status === "dismissed") continue;
    if (await set(KIND.groups, id, "decided")) accepted += 1;
    const moved = await answerSuggestions(store, id, true, now);
    accepted += moved.length;
    for (const s of moved) touched.add(s);
    // They were in no group: the ungrouped totals lose them.
    if (moved.length) left.add(null);
  }

  const dismiss = input.dismiss ?? {};
  await eachLimited(dismiss.subjects ?? [], 10, async (id) => {
    if (await set("sub", id, "dismissed")) dismissed += 1;
    const proposed = await store.pageAll("q", { where: [["subjectId", "==", id]], fields: ["subjectId", "status"] });
    for (const q of proposed) if (q.status === "proposed") await set("q", q.id, "dismissed");
    touched.add(id);
  });
  await eachLimited(dismiss.questions ?? [], 10, async (id) => {
    const q = await set("q", id, "dismissed");
    noteSituations(q);
    if (q) {
      dismissed += 1;
      if (typeof q.subjectId === "string") touched.add(q.subjectId);
    }
  });
  await eachLimited(dismiss.situations ?? [], 10, async (id) => {
    if (await set(KIND.situations, id, "dismissed")) dismissed += 1;
  });
  for (const id of new Set(dismiss.groups ?? [])) {
    if (await set(KIND.groups, id, "dismissed")) dismissed += 1;
    await answerSuggestions(store, id, false, now);
  }

  if (accepted) await markRecordsDecided(ctx, deps);
  return { accepted, dismissed, touched: [...touched], groups: [...left], situations: [...situations] };
}
