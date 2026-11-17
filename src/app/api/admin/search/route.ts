import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isSearchEnabled } from "@/lib/search/flags";
import { MAX_QUERY_CHARS, searchBrand } from "@/lib/search/query";
import { SEARCH_KINDS } from "@/lib/search/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  q: z.string().trim().min(1).max(MAX_QUERY_CHARS),
  kinds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((k) => k.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(SEARCH_KINDS)).max(SEARCH_KINDS.length)),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** Search what the signed-in brand wrote, by words and meaning (SEARCH_ENABLED). Any member may search. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isSearchEnabled()) return NextResponse.json({ error: "search_disabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    q: url.searchParams.get("q") ?? "",
    kinds: url.searchParams.get("kinds") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const out = await searchBrand(ctx, parsed.data.q, { kinds: parsed.data.kinds, limit: parsed.data.limit });
  if (!out.ok) {
    return out.error === "not_granted"
      ? NextResponse.json({ error: "search_not_granted" }, { status: 403 })
      : NextResponse.json({ error: out.error }, { status: 503 });
  }
  return NextResponse.json(out.result);
}
