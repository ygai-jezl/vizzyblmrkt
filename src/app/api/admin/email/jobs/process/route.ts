import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import type { TenantContext } from "@/lib/tenant/types";
import type { Region } from "@/lib/types/tenant";
import { processEmailJobs } from "@/lib/email/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drain the email delivery queue (due journey steps + queued broadcasts). Two
 * callers:
 *  - Cloud Scheduler: presents `X-Worker-Secret: $EMAIL_WORKER_SECRET` and runs
 *    against the bootstrap tenant (single-tenant MVP; multi-tenant fan-out is a
 *    follow-up).
 *  - An authenticated admin: runs against their own tenant context.
 */
export async function POST(req: Request) {
  const secret = process.env.EMAIL_WORKER_SECRET;
  const provided = req.headers.get("x-worker-secret");

  let ctx: TenantContext;
  if (secret && provided && provided === secret) {
    ctx = {
      tenantId: process.env.ADMIN_BOOTSTRAP_TENANT_ID ?? "ten_vzb",
      region: (process.env.ADMIN_BOOTSTRAP_REGION ?? "us") as Region,
      source: "system",
    };
  } else {
    const blocked = sameOriginGuard(req);
    if (blocked) return blocked;
    const admin = await getAdminContext();
    if (!admin) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    ctx = admin;
  }

  const result = await processEmailJobs(ctx, 100);
  return NextResponse.json({ ok: true, ...result });
}
