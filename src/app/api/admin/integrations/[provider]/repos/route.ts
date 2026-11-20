import { NextResponse } from "next/server";
import { z } from "zod";
import { integrationsAdmin } from "@/lib/integrations/admin";
import {
  clearTenantGitReconnect,
  getTenantById,
  markTenantGitReconnect,
  setTenantGitRepos,
} from "@/lib/tenant";
import { PROVIDERS, isGitProvider, type GitProvider } from "@/lib/integrations/providers";
import { ensureFreshGitToken } from "@/lib/integrations/tokenRefresh";
import {
  MAX_SELECTED_REPOS,
  RepoListError,
  githubOrgAccessUrl,
  isGitRepoSelectionEnabled,
  listAccessibleRepos,
} from "@/lib/integrations/repos";
import type { TenantContext } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Resolved =
  | {
      ok: true;
      ctx: TenantContext;
      provider: GitProvider;
      token: string;
      /** The stored ciphertext of `token`, for the compare-and-set reconnect mark. */
      ct: string;
      /** The connection carries a reconnect mark this listing may clear. */
      marked: boolean;
      selected: string[] | null;
    }
  | { ok: false; res: Response };

/**
 * Shared guard: flag, same-origin, the admin role (the list shows every private repo the
 * token can see across orgs, so members don't get it), provider, and a usable token. A
 * GitLab token is refreshed first when it is about to expire.
 */
async function resolve(req: Request, rawProvider: string): Promise<Resolved> {
  const fail = (error: string, status: number) => ({
    ok: false as const,
    res: NextResponse.json({ error }, { status }),
  });
  if (!isGitRepoSelectionEnabled()) return fail("not_found", 404);
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return { ok: false, res: gate.response };
  const { ctx } = gate;
  if (!isGitProvider(rawProvider)) return fail("unknown_provider", 400);

  const conn = (await getTenantById(ctx.tenantId))?.gitConnections?.[rawProvider];
  if (!conn) return fail("not_connected", 409);
  // A read-only GitHub App connection: the repos are chosen on GitHub's install screen.
  if (conn.kind === "app" || !conn.enc) return fail("managed_on_github", 409);
  const fresh = await ensureFreshGitToken(ctx, rawProvider, conn);
  if (!fresh.token || !fresh.ct) return fail("reconnect_required", 409);
  const selected = conn.repos ? conn.repos.map((r) => r.fullPath) : null;
  return {
    ok: true,
    ctx,
    provider: rawProvider,
    token: fresh.token,
    ct: fresh.ct,
    // A refresh refused just now keeps its mark, even if the old token still lists.
    marked: Boolean(conn.reconnect) && !fresh.reconnect,
    selected,
  };
}

/** The provider rejected the token: mark the connection (only while it still holds
 *  that token, so a refresh by another request isn't marked) and say reconnect. */
async function listFailure(
  err: unknown,
  r: { ctx: TenantContext; provider: GitProvider; ct: string },
): Promise<NextResponse> {
  if (err instanceof RepoListError && err.code === "reconnect_required") {
    await markTenantGitReconnect(r.ctx.tenantId, r.provider, r.ct, "provider_rejected").catch(() => {
      console.warn(`[git-refresh] ${r.provider} reconnect mark failed for ${r.ctx.tenantId}`);
    });
    return NextResponse.json({ error: "reconnect_required" }, { status: 409 });
  }
  return NextResponse.json({ error: "provider_error" }, { status: 502 });
}

/**
 * Every repo the connected account can read — personal and across all its
 * orgs/groups — plus which are selected (`selected: null` = legacy, all repos).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const r = await resolve(req, (await params).provider);
  if (!r.ok) return r.res;
  try {
    const { repos, truncated } = await listAccessibleRepos(r.provider, r.token);
    // The provider accepted the token, so the connection no longer needs reconnecting.
    if (r.marked) await clearTenantGitReconnect(r.ctx.tenantId, r.provider, r.ct).catch(() => false);
    const clientId = PROVIDERS[r.provider].clientId();
    return NextResponse.json({
      repos,
      truncated,
      selected: r.selected,
      maxSelected: MAX_SELECTED_REPOS,
      orgAccessUrl: r.provider === "github" && clientId ? githubOrgAccessUrl(clientId) : null,
    });
  } catch (err) {
    return listFailure(err, r);
  }
}

const PutSchema = z.object({
  repos: z.array(z.string().min(3).max(512)).max(MAX_SELECTED_REPOS),
});

/**
 * Save the selection. Paths are re-checked against a fresh listing so only repos
 * the connected account can actually read are stored.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const r = await resolve(req, (await params).provider);
  if (!r.ok) return r.res;
  const parsed = PutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  let accessible;
  try {
    accessible = (await listAccessibleRepos(r.provider, r.token)).repos;
  } catch (err) {
    return listFailure(err, r);
  }
  const byPath = new Map(accessible.map((x) => [x.fullPath, x]));
  const wanted = [...new Set(parsed.data.repos.map((p) => p.toLowerCase()))];
  const unknown = wanted.filter((p) => !byPath.has(p));
  if (unknown.length) {
    return NextResponse.json({ error: "unknown_repos", repos: unknown }, { status: 400 });
  }
  const repos = wanted.map((p) => {
    const x = byPath.get(p)!;
    return {
      fullPath: x.fullPath,
      owner: x.owner,
      private: x.private,
      defaultBranch: x.defaultBranch,
      webUrl: x.webUrl,
    };
  });
  // Removed meanwhile (a Disconnect won): nothing is written onto the gone connection.
  if (!(await setTenantGitRepos(r.ctx.tenantId, r.provider, repos))) {
    return NextResponse.json({ error: "not_connected" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, selected: repos.map((x) => x.fullPath) });
}
