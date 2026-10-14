import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import type { AdminGate } from "@/lib/connect/admin";
import { getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { tenantDomains } from "@/lib/knowledge/site";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { dismissBrandMapSuggestions, fileBrandMapSuggestions, readBrandMap, saveBrandMap, type MapResult } from "./store";
import { proposeBrandMap, summarise, type ProposeDeps } from "./research";
import { isBrandMapEnabled } from "./flags";

/**
 * The Brand map's admin APIs (Brand › Brand map): origin, flag, sign-in and admin, in that
 * order, as Email style's. Members can view the page but change nothing; saving, dismissing,
 * research and lookups are an admin's.
 */
export async function brandMapAdmin(
  req: Request,
  opts: { on?: () => boolean; offError?: string } = {},
): Promise<AdminGate> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  if (!isBrandMapEnabled() || (opts.on && !opts.on())) {
    return { ok: false, response: NextResponse.json({ error: opts.offError ?? "brand_map_disabled" }, { status: 503 }) };
  }
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (ctx.role !== "admin") return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { ok: true, ctx };
}

/** The domains the tenant record says the brand owns. */
export async function ownSitesOf(ctx: TenantContext): Promise<string[]> {
  try {
    return tenantDomains(await getTenantById(ctx.tenantId));
  } catch {
    return [];
  }
}

const Keys = z.array(z.string().min(1).max(200)).max(300).default([]);

const SaveBody = z.object({
  baseRev: z.number().int().min(0),
  map: z.unknown(),
  accepted: Keys,
  dismissed: Keys,
});

export function resultResponse<T>(r: MapResult<T>, ok: (value: T) => unknown): Response {
  if (r.ok) return NextResponse.json(ok(r.value));
  return NextResponse.json(
    { error: r.error, ...(r.issues ? { issues: r.issues } : {}), ...(r.current ? { map: r.current } : {}) },
    { status: r.status },
  );
}

/** PUT: save what the admin decided, and resolve the suggestions they accepted or dismissed. */
export async function saveFromRequest(ctx: TenantContext, body: unknown, deps: { db?: FirestoreLike } = {}): Promise<Response> {
  const parsed = SaveBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const saved = await saveBrandMap(
    ctx,
    {
      baseRev: parsed.data.baseRev,
      decided: parsed.data.map,
      accepted: parsed.data.accepted,
      dismissed: parsed.data.dismissed,
      ownSites: await ownSitesOf(ctx),
    },
    deps,
  );
  return resultResponse(saved, (map) => ({ ok: true, map }));
}

const DismissBody = z.object({ keys: z.array(z.string().min(1).max(200)).min(1).max(300) });

/** DELETE: dismiss suggestions now (no save needed). */
export async function dismissFromRequest(ctx: TenantContext, body: unknown, deps: { db?: FirestoreLike } = {}): Promise<Response> {
  const parsed = DismissBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const done = await dismissBrandMapSuggestions(ctx, parsed.data.keys, deps);
  return resultResponse(done, (map) => ({ ok: true, map }));
}

/** Research and Vizzy's "research" share this budget, per brand. */
export const RESEARCH_LIMIT = { prefix: "brand_map_research", burstLimit: 2, hourlyLimit: 10 };

/**
 * POST research: draft the map from the brand's own material and a web search, and file
 * what it found as suggestions (replacing research's earlier ones). Nothing decided changes.
 * Answers with the map as it now is, so a first run can fill the form at once.
 */
export async function researchFromRequest(
  ctx: TenantContext,
  deps: { db?: FirestoreLike; propose?: ProposeDeps; nowMs?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const read = await readBrandMap(ctx, deps.db);
  if (read.state === "unreadable") return NextResponse.json({ error: "map_unreadable" }, { status: 409 });
  const current = BrandMapDecidedSchema.parse(read.state === "ok" ? { identity: read.map.identity, subjects: read.map.subjects, names: read.map.names } : {});
  const proposed = await proposeBrandMap(ctx, { current, timeoutMs: deps.timeoutMs }, { db: deps.db, ...deps.propose });
  if (!proposed.ok) return NextResponse.json({ error: proposed.error }, { status: proposed.status });
  const at = new Date(deps.nowMs ?? Date.now()).toISOString();
  const filed = await fileBrandMapSuggestions(
    ctx,
    { from: "research", replaceOwn: true, items: proposed.items, research: { at, notes: proposed.notes } },
    { db: deps.db, nowMs: deps.nowMs },
  );
  if (!filed.ok) return NextResponse.json({ error: filed.error }, { status: filed.status });
  const after = await readBrandMap(ctx, deps.db);
  return NextResponse.json({
    ok: true,
    filed: filed.value.filed.length,
    summary: summarise(filed.value.filed.map((s) => s.change)),
    notes: proposed.notes,
    map: after.state === "ok" ? after.map : null,
  });
}
