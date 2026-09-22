import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById, setTenantGitRepos } from "@/lib/tenant";
import { PROVIDERS, isGitProvider, type GitProvider } from "@/lib/integrations/providers";
import { decryptToken } from "@/lib/integrations/crypto";
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
  | { ok: true; ctx: TenantContext; provider: GitProvider; token: string; selected: string[] | null }
  | { ok: false; res: NextResponse };

/** Shared guard: flag, same-origin, admin, provider, and a decryptable connection. */
async function resolve(req: Request, rawProvider: string): Promise<Resolved> {
  const fail = (error: string, status: number) => ({
    ok: false as const,
    res: NextResponse.json({ error }, { status }),
  });
  if (!isGitRepoSelectionEnabled()) return fail("not_found", 404);
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, res: blocked };
  const ctx = await getAdminContext();
  if (!ctx) return fail("unauthorized", 401);
  if (!isGitProvider(rawProvider)) return fail("unknown_provider", 400);

  const conn = (await getTenantById(ctx.tenantId))?.gitConnections?.[rawProvider];
  if (!conn) return fail("not_connected", 409);
  let token: string;
  try {
    token = decryptToken(conn.enc);
  } catch {
    return fail("reconnect_required", 409);
  }
  const selected = conn.repos ? conn.repos.map((r) => r.fullPath) : null;
  return { ok: true, ctx, provider: rawProvider, token, selected };
}

function listFailure(err: unknown): NextResponse {
  if (err instanceof RepoListError && err.code === "reconnect_required") {
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
    const clientId = PROVIDERS[r.provider].clientId();
    return NextResponse.json({
      repos,
      truncated,
      selected: r.selected,
      maxSelected: MAX_SELECTED_REPOS,
      orgAccessUrl: r.provider === "github" && clientId ? githubOrgAccessUrl(clientId) : null,
    });
  } catch (err) {
    return listFailure(err);
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
    return listFailure(err);
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
  await setTenantGitRepos(r.ctx.tenantId, r.provider, repos);
  return NextResponse.json({ ok: true, selected: repos.map((x) => x.fullPath) });
}
