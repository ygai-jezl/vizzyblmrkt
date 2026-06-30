import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { createWorkspace } from "@/lib/admin/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

/** List the tenant's active workspaces (newest first). */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const all = await forTenant(ctx).workspaces.find({ where: [], limit: 200 });
  const workspaces = all
    .filter((w) => !w.archivedAt)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return NextResponse.json({ workspaces });
}

/** Create a workspace. */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const workspace = await createWorkspace(ctx, {
    name: parsed.data.name,
    description: parsed.data.description ?? null,
  });
  return NextResponse.json({ workspace }, { status: 201 });
}
