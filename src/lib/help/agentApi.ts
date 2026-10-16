import { isBrandMapUiEnabled } from "@/lib/brandMap/flags";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { isEmailStyleUiEnabled } from "@/lib/email/flags";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { computeGrowth, nextStepOf } from "@/lib/nav/growth";
import { loadGrowthSignals } from "@/lib/nav/growthSignals";
import { isRateLimited } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { docsOrigin } from "@/lib/developers/flags";
import { helpPageMarkdown } from "./agentFiles";
import { isSetupGuideEnabled } from "./flags";
import { HELP_PAGES, helpPage } from "./pages";

/**
 * For Vizzy: where the brand is on its setup, and the help pages, so "What
 * should I set up first?" and "How do I…?" are answered from the brand's real
 * progress and the same pages people read. Auth: the signed canvas capability
 * token in `X-Canvas-Context`; gated by the setup guide flag.
 */

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

export function setupAgentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isSetupGuideEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

/** One status is ~15 Firestore reads; plenty for a chat. */
const STATUS_LIMIT = { prefix: "setup_agent", burstLimit: 10, hourlyLimit: 120 };

/** Links Vizzy can give: app pages are relative (the chat is in the app); help pages are full addresses. */
const helpUrl = (path: string | undefined, origin: string) => (path ? `${origin}${path}` : null);

export async function agentSetupStatus(ctx: TenantContext, db?: FirestoreLike, origin = docsOrigin()): Promise<ApiResult> {
  if (await isRateLimited(`tenant:${ctx.tenantId}`, STATUS_LIMIT, { db })) {
    return { status: 429, body: { error: "rate_limited" } };
  }
  const growth = computeGrowth(
    await loadGrowthSignals(
      ctx,
      {
        lifecycle: isLifecycleEnabled(),
        invites: isInvitesUiEnabled() && isInvitesEnabled(),
        setup: { emailStyle: isEmailStyleUiEnabled(), brandMap: isBrandMapUiEnabled() },
      },
      db,
    ),
  );
  const current = growth.stages.find((s) => s.key === growth.current) ?? null;
  const next = current ? nextStepOf(current) : null;
  return {
    status: 200,
    body: {
      allDone: growth.allRunning,
      currentStage: current ? { key: current.key, label: current.label, position: growth.stages.indexOf(current) + 1, of: growth.stages.length } : null,
      nextStep: next ? { label: next.label, appLink: next.href, howTo: helpUrl(next.howTo, origin), warning: next.warning ?? null } : null,
      stages: growth.stages.map((s) => ({
        key: s.key,
        label: s.label,
        status: s.status,
        steps: s.steps.map((st) => ({
          label: st.label,
          done: st.done,
          optional: !!st.optional,
          appLink: st.href,
          howTo: helpUrl(st.howTo, origin),
          needsFirst: st.done ? [] : (st.needs ?? []).map((n) => n.label),
          warning: st.done ? null : (st.warning ?? null),
        })),
      })),
      helpPages: HELP_PAGES.map((p) => ({ page: p.slug || "get-set-up", title: p.slug ? p.label : "Get set up", summary: p.summary, url: `${origin}${p.path}` })),
    },
  };
}

/** One help page as Markdown. `page` is a slug from helpPages; "get-set-up" is the hub. */
export function agentHelpPage(page: string, origin = docsOrigin()): ApiResult {
  const slug = page === "get-set-up" ? "" : page;
  const p = helpPage(slug);
  const markdown = p ? helpPageMarkdown(slug, origin) : null;
  if (!p || !markdown) {
    return { status: 404, body: { error: "not_found", pages: HELP_PAGES.map((x) => x.slug || "get-set-up") } };
  }
  return { status: 200, body: { page, title: p.slug ? p.label : "Get set up", url: `${origin}${p.path}`, markdown } };
}
