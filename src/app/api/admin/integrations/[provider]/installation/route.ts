import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById } from "@/lib/tenant";
import { githubAppConfig, listInstallationRepos, manageInstallationUrl } from "@/lib/integrations/githubApp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The account's GitHub connection, for the places a customer picks repos (Learn
 * from repo, knowledge sources): how it's connected, and — for the read-only
 * GitHub App — exactly the repositories they chose on GitHub, plus the link to
 * change that choice. Never a token.
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if ((await params).provider !== "github") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const app = githubAppConfig();
  if (!app) return NextResponse.json({ mode: "oauth" });
  const conn = (await getTenantById(ctx.tenantId))?.gitConnections?.github;
  const manageUrl = manageInstallationUrl(app);
  if (!conn) return NextResponse.json({ mode: "app", connected: false, manageUrl });
  if (conn.kind !== "app" || !conn.installationId) {
    // A classic (read/write) connection from before the app — offer the switch.
    return NextResponse.json({ mode: "app", connected: true, legacy: true, accountLogin: conn.accountLogin ?? null, manageUrl });
  }
  try {
    const { repos, truncated } = await listInstallationRepos(conn.installationId, app);
    return NextResponse.json({ mode: "app", connected: true, accountLogin: conn.accountLogin ?? null, manageUrl, repos, truncated });
  } catch {
    // Most often the customer uninstalled the app on GitHub.
    return NextResponse.json({ mode: "app", connected: true, accountLogin: conn.accountLogin ?? null, manageUrl, repos: [], error: "installation_unavailable" });
  }
}
