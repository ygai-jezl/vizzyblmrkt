import { createHash } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import { brandMapRecords, type BrandMapRecordStore } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { brandMapDocId, type BrandMap, type BrandMapSuggestion } from "@/lib/types/brandMap";
import {
  BrandMapQuestionRecordSchema,
  BrandMapSubjectRecordSchema,
  type RecordFrom,
  type RecordStatus,
} from "@/lib/types/brandMapRecords";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { embedSubjects } from "./embed";
import { proposedQuestion, proposedSubject } from "./proposals";
import { questionKey, subjectKey, urlKey } from "./keys";
import { parseBrandMap, readBrandMap } from "./store";

/**
 * The move (BRAND_MAP_SCALE_ENABLED): a brand's subjects and their questions leave its one
 * record for records of their own, once. Any WRITE can start it — opening the Brand map page
 * (which calls for it), research, Vizzy, accepting a proposal — and rendering a page never
 * does. It creates only what's missing and writes the marker LAST, so it is safe to run twice
 * or at once, and a map is never read as moved before its records are there.
 *
 * The old `subjects` list stays exactly as it was (store.ts keeps it on every later save), so
 * a build without the switch still reads it. If it changed while the switch was off, the next
 * move brings in what was added there (by id); a rename made there is not carried over, and
 * nothing a person removed since the move comes back (the marker keeps every id brought in,
 * and the keys of the suggestions already proposed).
 *
 * Waiting suggestions to add a subject, a question or a subject's home page become proposals
 * on the records. They stay in the record's list too (a build without the switch still shows
 * them); with the switch on, the page shows the proposals instead.
 */

export type MoveResult =
  | { ok: true; moved: boolean; subjects: number; questions: number; proposals: number }
  | { ok: false; status: number; error: string };

/**
 * A digest of the old list as stored: if it changes while the switch is off, the next move
 * brings in what was added. The stored form, not the parsed one, so a new default in a later
 * schema never looks like a change.
 */
export const arrayHash = (subjects: unknown) => createHash("sha256").update(JSON.stringify(subjects ?? [])).digest("hex").slice(0, 32);

const iso = (nowMs?: number) => new Date(nowMs ?? Date.now()).toISOString();

function stamp(now: string, status: RecordStatus, from: RecordFrom) {
  return { status, from, rev: 0, createdAt: now, updatedAt: now, decidedAt: status === "decided" ? now : null };
}

/**
 * The records for the subjects on the old list (decided: a person put them on the map), but
 * none brought in before (`seen`): one removed since stays removed, and so do its questions.
 */
async function copySubjects(ctx: TenantContext, store: BrandMapRecordStore, map: BrandMap, now: string, seen: Set<string>) {
  let subjects = 0;
  let questions = 0;
  for (const [i, s] of map.subjects.entries()) {
    const subject = BrandMapSubjectRecordSchema.parse({
      id: s.id,
      tenantId: ctx.tenantId,
      ...stamp(now, "decided", "move"),
      decidedAt: map.decidedAt ?? now,
      name: s.name,
      nameKey: subjectKey(s.name),
      home: s.home ?? null,
      urlKey: urlKey(s.home),
      order: i,
      counts: { questions: s.questions.length, open: s.questions.length },
    });
    if (!seen.has(s.id) && (await store.createIfAbsent("sub", s.id, strip(subject)))) subjects += 1;
    // A question added to a subject removed since has nowhere to go.
    const fresh = s.questions.filter((q) => !seen.has(q.id));
    if (fresh.length && seen.has(s.id) && !(await store.get("sub", s.id))) continue;
    for (const [j, q] of s.questions.entries()) {
      if (seen.has(q.id)) continue;
      const question = BrandMapQuestionRecordSchema.parse({
        id: q.id,
        tenantId: ctx.tenantId,
        ...stamp(now, "decided", "move"),
        decidedAt: map.decidedAt ?? now,
        subjectId: s.id,
        text: q.text,
        textKey: questionKey(q.text),
        intent: q.intent,
        order: j,
      });
      if (await store.createIfAbsent("q", q.id, strip(question))) questions += 1;
    }
  }
  return { subjects, questions };
}

const strip = <T extends { id: string; tenantId: string }>(r: T) => {
  const { id: _id, tenantId: _t, ...rest } = r;
  void _id;
  void _t;
  return rest;
};

/** Waiting suggestions about subjects (none proposed before), as proposals on the records. */
async function proposeFromSuggestions(ctx: TenantContext, store: BrandMapRecordStore, map: BrandMap, now: string, done: Set<string>): Promise<{ made: number; keys: string[] }> {
  let made = 0;
  const keys: string[] = [];
  const from = (s: BrandMapSuggestion): RecordFrom => s.from;
  const evidence = (s: BrandMapSuggestion) => (s.ref?.title ? `Suggested by the article “${s.ref.title}”` : "");
  for (const s of map.suggestions) {
    const c = s.change;
    if (done.has(s.key) || !(c.type === "add_subject" || c.type === "add_question" || (c.type === "set_home" && c.target === "subject"))) continue;
    keys.push(s.key);
    if (c.type === "add_subject") {
      if (await proposedSubject(ctx, store, { name: c.name, from: from(s), reason: s.reason, evidence: evidence(s), now })) made += 1;
    } else if (c.type === "add_question") {
      const subject = await proposedSubject(ctx, store, { name: c.subject, from: from(s), reason: s.reason, evidence: evidence(s), now, existingOk: true });
      if (!subject) continue;
      if (await proposedQuestion(ctx, store, { subjectId: subject.id, text: c.text, intent: c.intent, from: from(s), reason: s.reason, evidence: evidence(s), now })) made += 1;
    } else if (c.type === "set_home" && c.target === "subject") {
      const key = subjectKey(c.name);
      const [found] = await store.find("sub", { where: [["nameKey", "==", key]], limit: 1 });
      if (!found) continue;
      const done = await store.claim("sub", found.id, (cur) =>
        cur.home || (typeof cur.suggestedHome === "string" && normalizeUrl(cur.suggestedHome) === normalizeUrl(c.url)) ? null : { suggestedHome: c.url, updatedAt: now },
      );
      if (done) made += 1;
    }
  }
  return { made, keys };
}

/** Move the brand's subjects into records, unless they already are (and the old list hasn't changed since). */
export async function ensureMoved(ctx: TenantContext, deps: { db?: FirestoreLike; nowMs?: number } = {}): Promise<MoveResult> {
  const now = iso(deps.nowMs);
  const read = await readBrandMap(ctx, deps.db);
  if (read.state === "unreadable") return { ok: false, status: 409, error: "map_unreadable" };
  const repo = forTenant(ctx, deps.db).brandMaps;
  if (read.state === "none") {
    // An empty map, marked moved: records can be added from the start.
    await repo.upsert(
      brandMapDocId(ctx.tenantId),
      () => ({ rev: 0, suggestions: [], dismissed: [], research: null, decidedAt: null, decidedBy: null, createdAt: now, updatedAt: now, moved: { at: now, arrayHash: arrayHash([]) }, recordsDecidedAt: null, pagesReadAt: null }) as never,
      (current) => (parseBrandMap(current)?.moved ? null : ({ moved: { at: now, arrayHash: arrayHash([]) }, updatedAt: now } as never)),
    );
    return { ok: true, moved: true, subjects: 0, questions: 0, proposals: 0 };
  }
  const map = read.map;
  const raw = await repo.getById(brandMapDocId(ctx.tenantId)).catch(() => null);
  const hash = arrayHash((raw as { subjects?: unknown } | null)?.subjects ?? []);
  if (map.moved?.arrayHash === hash) return { ok: true, moved: false, subjects: 0, questions: 0, proposals: 0 };

  const store = brandMapRecords(ctx, deps.db);
  const seen = new Set(map.moved?.ids ?? []);
  const copied = await copySubjects(ctx, store, map, now, seen);
  const proposed = await proposeFromSuggestions(ctx, store, map, now, new Set(map.moved?.suggestions ?? []));
  const proposals = proposed.made;
  const listed = map.subjects.flatMap((s) => [s.id, ...s.questions.map((q) => q.id)]);
  // The marker last: until it is written, the map still reads from its old list.
  await repo.claim(brandMapDocId(ctx.tenantId), (current) => {
    const fresh = parseBrandMap(current);
    if (!fresh) return null;
    // The list as it was copied (if it changes meanwhile, the next move brings that in), and
    // everything brought in so far, so a later move never brings back one removed since.
    return {
      moved: {
        at: fresh.moved?.at ?? now,
        arrayHash: hash,
        ids: [...new Set([...(fresh.moved?.ids ?? []), ...listed])].slice(0, 400),
        suggestions: [...new Set([...(fresh.moved?.suggestions ?? []), ...proposed.keys])].slice(-1000),
      },
      updatedAt: now,
    } as never;
  });
  // Their meaning, for finding the subjects close to an article (best effort; never failing the move).
  const ids = [...map.subjects.map((s) => s.id), ...(await store.find("sub", { where: [["status", "==", "proposed"]], limit: 200 }).catch(() => [])).map((s) => s.id)];
  await embedSubjects(ctx, ids, deps).catch(() => 0);
  return { ok: true, moved: true, subjects: copied.subjects, questions: copied.questions, proposals };
}
