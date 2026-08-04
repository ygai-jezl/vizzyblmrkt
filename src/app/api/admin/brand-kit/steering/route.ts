import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { isContentSteeringEnabled } from "@/lib/content/brandKit";
import { getSteeringState } from "@/lib/distribute/feedback/steeringState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Content Steering — read the tenant's learned post-performance directive per channel + its version
 * timeline (each with the judge rationale + evidence). Powers the transparency panel. Tenant-scoped,
 * read-only, FLAG-GATED (503 until CONTENT_STEERING_ENABLED).
 */
export async function GET() {
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isContentSteeringEnabled()) {
    return NextResponse.json({ error: "content_steering_disabled" }, { status: 503 });
  }
  const channels = await getSteeringState(ctx);
  return NextResponse.json({ channels });
}
