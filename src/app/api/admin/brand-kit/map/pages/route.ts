import { NextResponse } from "next/server";
import { z } from "zod";
import { isRateLimited } from "@/lib/tenant";
import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapPagesEnabled } from "@/lib/brandMap/flags";
import { BACKFILL_LIMIT, BackfillCursorSchema, readExistingPages } from "@/lib/brandMap/backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ cursor: BackfillCursorSchema.nullable().default(null) });

/**
 * "Read what's already there" (Brand › Brand map): one batch of the brand's existing articles
 * and the pages already crawled on its site, as rows on the map. Answers where to carry on;
 * the page calls again until `done`. Admin-only, rate-limited. FLAG-GATED (503 until
 * BRAND_MAP_PAGES_ENABLED).
 */
export async function POST(req: Request) {
  const g = await brandMapAdmin(req, { on: isBrandMapPagesEnabled, offError: "pages_disabled" });
  if (!g.ok) return g.response;
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  if (await isRateLimited(`tenant:${g.ctx.tenantId}`, BACKFILL_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  return NextResponse.json(await readExistingPages(g.ctx, parsed.data.cursor));
}
