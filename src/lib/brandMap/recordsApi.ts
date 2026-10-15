import { NextResponse } from "next/server";
import { z } from "zod";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BlogIntent } from "@/lib/types/contentPlan";
import { ownSitesOf } from "./adminApi";
import { afterRecordsChange } from "./afterChange";
import { ensureMoved } from "./move";
import { decideProposals } from "./proposals";
import { recountGroup, recountSubject } from "./recount";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import {
  addQuestion,
  createGroup,
  createSubject,
  editQuestion,
  editSubject,
  getSubject,
  listGroups,
  listSubjects,
  mergeSubjects,
  removeGroup,
  removeQuestion,
  removeSubject,
  renameGroup,
  subjectIndex,
  subjectQuestions,
  type RecordResult,
} from "./records";
import { readBrandMap } from "./store";

/**
 * The map at any size's admin APIs (BRAND_MAP_SCALE_ENABLED): reading and editing its
 * subjects, questions and groups, and deciding proposals. Every write moves the map first if
 * it hasn't been (the move never happens on a read). The routes gate with brandMapAdmin:
 * origin, switch, sign-in and admin, in that order.
 */

type Deps = { db?: FirestoreLike; nowMs?: number };

const Id = z.string().min(1).max(64);
const Ids = z.array(Id).max(500).default([]);
const ProposalSet = z.object({ subjects: Ids, questions: Ids, situations: Ids }).partial();
const Name = z.string().min(1).max(200);
const Home = z.string().max(300).nullable();

const invalid = () => NextResponse.json({ error: "invalid_input" }, { status: 400 });

/** A record result as a response: the value, or the error with the record as it is now. */
export function recordResponse<T>(r: RecordResult<T>): Response {
  if (r.ok) return NextResponse.json({ ok: true, value: r.value, touched: r.touched });
  return NextResponse.json({ error: r.error, ...(r.current ? { current: r.current } : {}) }, { status: r.status });
}

/** The brand's own sites: a home page must be on one. */
async function ownSites(ctx: TenantContext, deps: Deps): Promise<string[]> {
  const [read, domains] = await Promise.all([readBrandMap(ctx, deps.db).catch(() => null), ownSitesOf(ctx)]);
  return [read?.state === "ok" ? read.map.identity.site : "", ...domains].filter(Boolean);
}

/** Move first; a map that can't be read refuses every write. */
async function moved(ctx: TenantContext, deps: Deps): Promise<Response | null> {
  const r = await ensureMoved(ctx, deps);
  return r.ok ? null : NextResponse.json({ error: r.error }, { status: r.status });
}

/** After a write: the touched subjects' counts and embeddings follow (best effort, never failing it). */
async function settle<T>(ctx: TenantContext, r: RecordResult<T>, deps: Deps): Promise<Response> {
  if (r.ok && r.touched.length) await afterRecordsChange(ctx, { subjects: r.touched }, deps);
  return recordResponse(r);
}

export async function moveFromRequest(ctx: TenantContext, deps: Deps = {}): Promise<Response> {
  const r = await ensureMoved(ctx, deps);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}

const DecideBody = z.object({ accept: ProposalSet.optional(), dismiss: ProposalSet.optional() });

export async function proposalsFromRequest(ctx: TenantContext, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = DecideBody.safeParse(body);
  if (!parsed.success) return invalid();
  const blocked = await moved(ctx, deps);
  if (blocked) return blocked;
  const r = await decideProposals(ctx, parsed.data, deps);
  if (r.touched.length) await afterRecordsChange(ctx, { subjects: r.touched }, deps);
  return NextResponse.json({ ok: true, ...r });
}

/** GET subjects: all, one group's (`group=<id>`), or the ungrouped ones (`group=none`); `status=proposed` for proposals. */
export async function listSubjectsFromRequest(ctx: TenantContext, url: URL, deps: Deps = {}): Promise<Response> {
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (read?.state !== "ok" || !read.map.moved) return NextResponse.json({ moved: false, subjects: [] });
  const group = url.searchParams.get("group");
  const status = url.searchParams.get("status");
  const subjects = await listSubjects(
    ctx,
    {
      ...(group && group !== "all" ? { groupId: group === "none" ? null : group } : {}),
      ...(status === "proposed" || status === "decided" ? { status } : {}),
    },
    deps,
  );
  return NextResponse.json({ moved: true, subjects });
}

/**
 * GET one subject: its questions and what the brand's pages answer of them, worked out now
 * (opening a subject also brings its stored counts up to date).
 */
export async function subjectFromRequest(ctx: TenantContext, id: string, deps: Deps = {}): Promise<Response> {
  const read = await recountSubject(ctx, id, deps).catch(() => null);
  if (read) {
    return NextResponse.json({
      subject: read.subject,
      questions: read.questions,
      coverage: read.coverage,
      overlaps: read.overlaps,
      missingLinks: read.missingLinks,
    });
  }
  const subject = await getSubject(ctx, id, deps);
  if (!subject) return NextResponse.json({ error: "no_subject" }, { status: 404 });
  return NextResponse.json({ subject, questions: await subjectQuestions(ctx, subject.id, deps), coverage: null, overlaps: [], missingLinks: [] });
}

/** A batch per call, with a person waiting on each: generous, but bounded. */
export const RECOUNT_LIMIT = { prefix: "brand_map_recount", burstLimit: 60, hourlyLimit: 2000 };
const RECOUNT_BATCH = 20;
const RecountBody = z.object({ cursor: Id.nullable().default(null) });

/**
 * POST the recount pass (after "Read what's already there"): every subject's counts worked
 * out again, a batch per call in id order, then every group's totals. Hands back where to
 * carry on until done.
 */
export async function recountFromRequest(ctx: TenantContext, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = RecountBody.safeParse(body ?? {});
  if (!parsed.success) return invalid();
  if (await isRateLimited(`tenant:${ctx.tenantId}`, RECOUNT_LIMIT, { db: deps.db })) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const store = brandMapRecords(ctx, deps.db);
  const batch = await store.find("sub", { orderBy: [["ref", "asc"]], ...(parsed.data.cursor ? { startAfter: [parsed.data.cursor] } : {}), limit: RECOUNT_BATCH });
  for (let i = 0; i < batch.length; i += 5) await Promise.all(batch.slice(i, i + 5).map((s) => recountSubject(ctx, s.id, deps).catch(() => null)));
  if (batch.length === RECOUNT_BATCH) return NextResponse.json({ ok: true, done: false, next: batch[batch.length - 1]!.id, subjects: batch.length });
  const groups = await listGroups(ctx, deps);
  await Promise.all([...groups.map((g) => recountGroup(ctx, g.id, deps).catch(() => null)), recountGroup(ctx, null, deps).catch(() => null)]);
  return NextResponse.json({ ok: true, done: true, next: null, subjects: batch.length });
}

export async function subjectNamesFromRequest(ctx: TenantContext, deps: Deps = {}): Promise<Response> {
  return NextResponse.json({ subjects: await subjectIndex(ctx, deps) });
}

const CreateSubjectBody = z.object({ name: Name, groupId: Id.nullable().optional(), home: Home.optional() });

export async function createSubjectFromRequest(ctx: TenantContext, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = CreateSubjectBody.safeParse(body);
  if (!parsed.success) return invalid();
  const blocked = await moved(ctx, deps);
  if (blocked) return blocked;
  return settle(ctx, await createSubject(ctx, { ...parsed.data, ownSites: await ownSites(ctx, deps) }, deps), deps);
}

const EditSubjectBody = z.object({ baseRev: z.number().int().min(0), name: Name.optional(), home: Home.optional(), groupId: Id.nullable().optional() });

export async function editSubjectFromRequest(ctx: TenantContext, id: string, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = EditSubjectBody.safeParse(body);
  if (!parsed.success) return invalid();
  const blocked = await moved(ctx, deps);
  if (blocked) return blocked;
  return settle(ctx, await editSubject(ctx, id, { ...parsed.data, ownSites: await ownSites(ctx, deps) }, deps), deps);
}

export async function removeSubjectFromRequest(ctx: TenantContext, id: string, deps: Deps = {}): Promise<Response> {
  const blocked = await moved(ctx, deps);
  if (blocked) return blocked;
  return settle(ctx, await removeSubject(ctx, id, deps), deps);
}

const MergeBody = z.object({ from: Id, into: Id });

export async function mergeSubjectsFromRequest(ctx: TenantContext, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = MergeBody.safeParse(body);
  if (!parsed.success) return invalid();
  const blocked = await moved(ctx, deps);
  if (blocked) return blocked;
  return settle(ctx, await mergeSubjects(ctx, parsed.data, deps), deps);
}

const AddQuestionBody = z.object({ text: z.string().min(1).max(300), intent: BlogIntent.optional(), situationIds: z.array(Id).max(10).optional() });

export async function addQuestionFromRequest(ctx: TenantContext, subjectId: string, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = AddQuestionBody.safeParse(body);
  if (!parsed.success) return invalid();
  const blocked = await moved(ctx, deps);
  if (blocked) return blocked;
  return settle(ctx, await addQuestion(ctx, subjectId, parsed.data, deps), deps);
}

const EditQuestionBody = z.object({
  baseRev: z.number().int().min(0),
  text: z.string().min(1).max(300).optional(),
  intent: BlogIntent.optional(),
  situationIds: z.array(Id).max(10).optional(),
  subjectId: Id.optional(),
});

export async function editQuestionFromRequest(ctx: TenantContext, id: string, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = EditQuestionBody.safeParse(body);
  if (!parsed.success) return invalid();
  const blocked = await moved(ctx, deps);
  if (blocked) return blocked;
  return settle(ctx, await editQuestion(ctx, id, parsed.data, deps), deps);
}

export async function removeQuestionFromRequest(ctx: TenantContext, id: string, deps: Deps = {}): Promise<Response> {
  const blocked = await moved(ctx, deps);
  if (blocked) return blocked;
  return settle(ctx, await removeQuestion(ctx, id, deps), deps);
}

export async function groupsFromRequest(ctx: TenantContext, deps: Deps = {}): Promise<Response> {
  return NextResponse.json({ groups: await listGroups(ctx, deps) });
}

export async function createGroupFromRequest(ctx: TenantContext, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = z.object({ name: Name }).safeParse(body);
  if (!parsed.success) return invalid();
  const blocked = await moved(ctx, deps);
  if (blocked) return blocked;
  return recordResponse(await createGroup(ctx, parsed.data, deps));
}

export async function renameGroupFromRequest(ctx: TenantContext, id: string, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = z.object({ baseRev: z.number().int().min(0), name: Name }).safeParse(body);
  if (!parsed.success) return invalid();
  const blocked = await moved(ctx, deps);
  if (blocked) return blocked;
  return recordResponse(await renameGroup(ctx, id, parsed.data, deps));
}

export async function removeGroupFromRequest(ctx: TenantContext, id: string, deps: Deps = {}): Promise<Response> {
  const blocked = await moved(ctx, deps);
  if (blocked) return blocked;
  return settle(ctx, await removeGroup(ctx, id, deps), deps);
}
