import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { listImageAssets } from "@/lib/admin/brandKit";
import { isBrandKitEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List the tenant's Brand Kit image assets (newest first, keyset-paginated). The RSC
 * page loads page 1; this route serves "Load more" (and an optional ?kind= filter).
 * FLAG-GATED (503 until BRAND_KIT_ENABLED). Tenant-scoped by forTenant().
 */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandKitEnabled()) {
    return NextResponse.json({ error: "brand_kit_disabled" }, { status: 503 });
  }

  const sp = new URL(req.url).searchParams;
  try {
    const { items, nextCursor } = await listImageAssets(ctx, {
      cursor: sp.get("cursor") ?? undefined,
      kind: sp.get("kind") ?? undefined,
    });
    return NextResponse.json({ images: items, nextCursor });
  } catch (err) {
    // A missing/building composite index surfaces here — degrade to an empty page
    // rather than a 500 so the gallery still renders.
    console.error("[brand-kit] list images failed (index building?)", err);
    return NextResponse.json({ images: [], nextCursor: null });
  }
}
