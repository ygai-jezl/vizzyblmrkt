import type { BrandMapRecordStore } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import type { BlogIntent } from "@/lib/types/contentPlan";
import type { BrandMapStoredRecord, RecordFrom } from "@/lib/types/brandMapRecords";
import { BrandMapQuestionRecordSchema, BrandMapSubjectRecordSchema } from "@/lib/types/brandMapRecords";
import { freshId, questionIdFor, questionKey, subjectIdFor, subjectKey } from "./keys";

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
  if (found) return input.existingOk && found.status !== "dismissed" ? found : null;
  if (input.dismissedKeys?.has(`subject:${key}`)) return null;
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
  if (found) return null;
  if (input.subjectName && input.dismissedKeys?.has(`q:${subjectKey(input.subjectName)}:${subjectKey(text)}`)) return null;
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
