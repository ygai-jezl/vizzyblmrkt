import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { githubAppConfig, isGitHubAppLinkEnabled } from "@/lib/integrations/githubApp";
import { readChooseToken, saveAppConnection } from "@/lib/integrations/githubAppLink";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Which GitHub account?" — the step after GitHub confirms who's connecting.
 * GET lists the installs in the callback's signed `choose` token (tenant-bound,
 * ten minutes); POST saves the one picked. Only installs in that token can be
 * saved, and the callback put only read-only ones this person can access in it.
 */
async function guard(req: Request, params: Promise<{ provider: string }>) {
  const blocked = sameOriginGuard(req);
  if (blocked) return { error: blocked };
  const ctx = await getAdminContext();
  if (!ctx) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if ((await params).provider !== "github" || !githubAppConfig() || !isGitHubAppLinkEnabled()) {
    return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  }
  return { ctx };
}

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const g = await guard(req, params);
  if (g.error) return g.error;
  const choices = readChooseToken(new URL(req.url).searchParams.get("c") ?? "", g.ctx.tenantId);
  if (!choices) return NextResponse.json({ error: "choice_expired" }, { status: 400 });
  return NextResponse.json({ choices });
}

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const g = await guard(req, params);
  if (g.error) return g.error;
  const body = (await req.json().catch(() => null)) as { c?: unknown; installationId?: unknown } | null;
  const choices = typeof body?.c === "string" ? readChooseToken(body.c, g.ctx.tenantId) : null;
  if (!choices) return NextResponse.json({ error: "choice_expired" }, { status: 400 });
  const pick = choices.find((x) => x.installationId === body?.installationId);
  if (!pick) return NextResponse.json({ error: "not_a_choice" }, { status: 400 });
  await saveAppConnection(g.ctx.tenantId, g.ctx.userId, pick);
  return NextResponse.json({ ok: true, accountLogin: pick.accountLogin });
}
