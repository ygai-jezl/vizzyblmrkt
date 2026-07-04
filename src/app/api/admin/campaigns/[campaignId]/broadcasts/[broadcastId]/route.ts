import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, TenantIsolationError } from "@/lib/tenant";
import { AgentMetaSchema } from "@/lib/types/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateBroadcastSchema = z
  .object({
    name: z.string().min(1).max(140),
    subject: z.string().max(300),
    body: z.string().max(50_000),
    // z.string().url() accepts javascript:/data: — require an explicit http(s) scheme.
    heroImageUrl: z
      .string()
      .max(2000)
      .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL")
      .nullable(),
    agentMeta: AgentMetaSchema,
  })
  .partial();

type RouteParams = { params: Promise<{ campaignId: string; broadcastId: string }> };

export async function GET(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId, broadcastId } = await params;
  const broadcast = await forTenant(ctx).broadcasts.getById(broadcastId);
  if (!broadcast || broadcast.campaignId !== campaignId) {
    return NextResponse.json({ error: "broadcast_not_found" }, { status: 404 });
  }
  return NextResponse.json({ broadcast });
}

/** Update a draft broadcast's content. */
export async function PUT(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId, broadcastId } = await params;
  const existing = await forTenant(ctx).broadcasts.getById(broadcastId);
  if (!existing || existing.campaignId !== campaignId) {
    return NextResponse.json({ error: "broadcast_not_found" }, { status: 404 });
  }
  if (existing.status === "sent" || existing.status === "sending") {
    return NextResponse.json({ error: "not_editable" }, { status: 409 });
  }

  const parsed = UpdateBroadcastSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_input",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    await forTenant(ctx).broadcasts.update(broadcastId, {
      ...parsed.data,
      // Editing a failed draft clears the error and returns it to draft.
      ...(existing.status === "failed"
        ? { status: "draft" as const, lastError: null }
        : {}),
    });
  } catch (err) {
    if (err instanceof TenantIsolationError) {
      return NextResponse.json({ error: "broadcast_not_found" }, { status: 404 });
    }
    throw err;
  }

  const broadcast = await forTenant(ctx).broadcasts.getById(broadcastId);
  return NextResponse.json({ ok: true, broadcast });
}
