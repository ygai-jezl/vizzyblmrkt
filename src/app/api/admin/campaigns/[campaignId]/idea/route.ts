import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isIdeasEnabled } from "@/lib/ideas/flags";
import { IdeaChangeSchema, setIdea } from "@/lib/ideas/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Change a launch's idea (LAUNCH_IDEAS_ENABLED): its hypothesis, status, outcome, hand-off or Just
 * a list, and optionally close the waitlist of a parked or killed idea. Admins only: members read
 * the idea on the Overview. Checks, in order: same origin, the switch (404 while off, as if the
 * route didn't exist), sign-in (401), admin (403), a strict body (400). Another brand's launch is
 * not found.
 *
 * Body: any of `{ hypothesis, outcome, status, productConnectionId, justAList, closeWaitlist }`.
 * Answers `{ ok, idea, changed, archived }`; `archived` is null unless closing was asked for, and
 * false when the status saved but the waitlist didn't close.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isIdeasEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = IdeaChangeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const { campaignId } = await params;
  const result = await setIdea(ctx, campaignId, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, idea: result.idea, changed: result.changed, archived: result.archived });
}
