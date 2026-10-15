import { NextResponse } from "next/server";
import { z } from "zod";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { SituationSide, SituationW } from "@/lib/types/brandMapRecords";
import type { EmbedDeps } from "./embed";
import { findSituations, type FindDeps } from "./findSituations";
import { moveFirst, recordResponse } from "./recordsApi";
import { takeStep } from "./runs";
import { askSituationQuestions, type AskDeps } from "./situationQuestions";
import { createSituation, editSituation, listSituations, readSituation, removeSituation } from "./situations";

/**
 * Buying situations' admin APIs (BRAND_MAP_SITUATIONS_ENABLED): members read them; admins
 * add, edit, star and remove them. Every write moves the map first if it hasn't been.
 * Proposals are decided through the map's proposals route, with the rest.
 */

type Deps = { db?: FirestoreLike; nowMs?: number; embed?: Omit<EmbedDeps, "db" | "nowMs"> };

const Part = z.string().max(120);
const Fields = {
  w: SituationW.optional(),
  wText: Part.optional(),
  who: Part.optional(),
  side: SituationSide.optional(),
  want: Part.optional(),
  feel: Part.optional(),
};
const CreateBody = z.object({ text: z.string().min(1).max(200), ...Fields });
const EditBody = z.object({ baseRev: z.number().int().min(0), text: z.string().min(1).max(200).optional(), focus: z.boolean().optional(), ...Fields });

const invalid = () => NextResponse.json({ error: "invalid_input" }, { status: 400 });

export async function listSituationsFromRequest(ctx: TenantContext, deps: Deps = {}): Promise<Response> {
  return NextResponse.json({ situations: await listSituations(ctx, deps) });
}

export async function situationFromRequest(ctx: TenantContext, id: string, deps: Deps = {}): Promise<Response> {
  const read = await readSituation(ctx, id, deps);
  return read ? NextResponse.json(read) : NextResponse.json({ error: "no_situation" }, { status: 404 });
}

export async function createSituationFromRequest(ctx: TenantContext, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) return invalid();
  const blocked = await moveFirst(ctx, deps);
  if (blocked) return blocked;
  return recordResponse(await createSituation(ctx, parsed.data, deps));
}

export async function editSituationFromRequest(ctx: TenantContext, id: string, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = EditBody.safeParse(body);
  if (!parsed.success) return invalid();
  const blocked = await moveFirst(ctx, deps);
  if (blocked) return blocked;
  return recordResponse(await editSituation(ctx, id, parsed.data, deps));
}

export async function removeSituationFromRequest(ctx: TenantContext, id: string, deps: Deps = {}): Promise<Response> {
  const blocked = await moveFirst(ctx, deps);
  if (blocked) return blocked;
  return recordResponse(await removeSituation(ctx, id, deps));
}

const FindBody = z.object({ runId: z.string().min(1).max(64), customers: z.string().max(300).optional() });

/**
 * POST research's first step for buying situations, as a step of a "situations" run: what it
 * finds is proposed (unbacked ones marked), for a person to tick and add.
 */
export async function findSituationsFromRequest(ctx: TenantContext, body: unknown, deps: Deps & { find?: Omit<FindDeps, "db" | "nowMs"> } = {}): Promise<Response> {
  const parsed = FindBody.safeParse(body);
  if (!parsed.success) return invalid();
  const step = await takeStep(ctx, parsed.data.runId, "situations", deps);
  if (!step.ok) return NextResponse.json({ error: step.error }, { status: step.status });
  const blocked = await moveFirst(ctx, deps);
  if (blocked) return blocked;
  const r = await findSituations(ctx, { customers: parsed.data.customers }, { db: deps.db, nowMs: deps.nowMs, embed: deps.embed, ...deps.find });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, found: r.found, skipped: r.skipped, notes: r.notes, stepsLeft: step.value.stepsLeft });
}

const AskBody = z.object({ runId: z.string().min(1).max(64) });

/**
 * POST research's second step for one situation, as a step of the same run: the questions
 * people in it ask, each placed in a subject (or a new one), proposed.
 */
export async function situationQuestionsFromRequest(
  ctx: TenantContext,
  id: string,
  body: unknown,
  deps: Deps & { ask?: Omit<AskDeps, "db" | "nowMs" | "embed"> } = {},
): Promise<Response> {
  const parsed = AskBody.safeParse(body);
  if (!parsed.success) return invalid();
  const step = await takeStep(ctx, parsed.data.runId, "situations", deps);
  if (!step.ok) return NextResponse.json({ error: step.error }, { status: step.status });
  const blocked = await moveFirst(ctx, deps);
  if (blocked) return blocked;
  const r = await askSituationQuestions(ctx, id, { db: deps.db, nowMs: deps.nowMs, embed: deps.embed, ...deps.ask });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, questions: r.questions, stepsLeft: step.value.stepsLeft });
}
