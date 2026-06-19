import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  processEmailJobs,
  processEmailJobsForAllTenants,
} from "@/lib/email/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drain the email delivery queue (due journey steps + queued broadcasts). Two
 * callers:
 *  - Cloud Scheduler: presents `X-Worker-Secret: $EMAIL_WORKER_SECRET` and fans
 *    out across EVERY tenant and regional database (US/EU/Asia) — a cron has no
 *    single tenant context, so it must drain them all.
 *  - An authenticated admin: runs against their own tenant context only.
 */
export async function POST(req: Request) {
  const secret = process.env.EMAIL_WORKER_SECRET;
  const provided = req.headers.get("x-worker-secret");

  // Machine (scheduler) caller: authenticated by the shared worker secret. Both
  // sides must be non-empty so an unset secret can never authenticate an empty
  // header — it falls through to the admin-session path instead.
  if (secret && provided && provided === secret) {
    const result = await processEmailJobsForAllTenants(100);
    return NextResponse.json({ ok: true, mode: "all_tenants", ...result });
  }

  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const admin = await getAdminContext();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await processEmailJobs(admin, 100);
  return NextResponse.json({ ok: true, mode: "tenant", ...result });
}
