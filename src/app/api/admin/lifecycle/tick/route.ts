import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { workerSecretMatches } from "@/lib/http/workerSecret";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { drainLifecycleTenant, runLifecycleTick } from "@/lib/lifecycle/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Run the lifecycle journeys (due enrolments + outbound webhooks). Two callers:
 *  - Cloud Scheduler, every 2 minutes, with `X-Worker-Secret:
 *    $LIFECYCLE_WORKER_SECRET` — fans out across every tenant and region;
 *  - a signed-in admin — runs their own tenant only.
 * While LIFECYCLE_ENABLED is off the scheduler gets a no-op 200 (so it doesn't
 * alarm on a dark deploy) and everyone else a 404.
 */
export async function POST(req: Request) {
  const machine = workerSecretMatches(req.headers.get("x-worker-secret"), process.env.LIFECYCLE_WORKER_SECRET);
  if (!isLifecycleEnabled()) {
    return machine
      ? NextResponse.json({ ok: true, skipped: "lifecycle_disabled" })
      : NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (machine) {
    const result = await runLifecycleTick();
    return NextResponse.json({ ok: true, mode: "all_tenants", ...result });
  }

  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const admin = await getAdminContext();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await drainLifecycleTenant(admin);
  return NextResponse.json({ ok: true, mode: "tenant", ...result });
}
