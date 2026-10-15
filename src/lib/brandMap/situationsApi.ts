import { NextResponse } from "next/server";
import { z } from "zod";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { SituationSide, SituationW } from "@/lib/types/brandMapRecords";
import type { EmbedDeps } from "./embed";
import { moveFirst, recordResponse } from "./recordsApi";
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
