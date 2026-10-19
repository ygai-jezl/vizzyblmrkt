import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, getTenantById } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { MAX_SCREENSHOT_BYTES, sniffImageMime } from "@/lib/workspace/assetStore";
import { isBlogHeroEnabled } from "@/lib/content/imageStyle/flags";
import { heroFromUpload } from "@/lib/content/blog/hero";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string; nodeId: string }> };

/**
 * Use the person's own image as a blog article's hero (BLOG_HERO_ENABLED): PNG or JPEG (the
 * renderer can't read WebP), sniffed, up to 8 MB. It's cropped to 1600x900 and given a share
 * card with the title over it.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBlogHeroEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId, nodeId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  if (file.size > MAX_SCREENSHOT_BYTES) {
    return NextResponse.json({ error: "too_large", message: "Image is too large (max 8 MB)." }, { status: 413 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const mime = sniffImageMime(bytes);
  if (mime !== "image/png" && mime !== "image/jpeg") {
    return NextResponse.json({ error: "bad_type", message: "Upload a PNG or JPG image." }, { status: 400 });
  }
  const tenant = await getTenantById(ctx.tenantId);
  const r = await heroFromUpload({ ctx, tenant, workspaceId, planId, nodeId }, { bytes, mimeType: mime });
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error, ...(r.error === "store_failed" ? { message: "Couldn't save the image. Try again." } : {}) },
      { status: r.status },
    );
  }
  return NextResponse.json({ hero: r.hero });
}
