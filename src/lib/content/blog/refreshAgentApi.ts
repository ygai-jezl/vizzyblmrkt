import { autopilotHolds } from "@/lib/autopilot/planLock";
import { isBlogRefreshChatEnabled } from "@/lib/brandMap/flags";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { meaningsOf, numberKeys } from "@/lib/metrics/meanings";
import { isRateLimited, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import type { ArticleReviewDoc } from "@/lib/types/articleRefresh";
import { refreshHref } from "./freshnessHref";
import { readFreshnessWatch } from "./freshnessPages";
import { mayStartReview } from "./refreshGate";
import { advanceReview, readReview, startReview, type ReviewDeps } from "./refreshReview";
import { evidenceLine, KIND_SAID, STEP_SAID } from "./refreshWords";

/**
 * For Vizzy's review_article (/api/agent/article-review, BLOG_REFRESH_CHAT_ENABLED): start a
 * refresh review of a live article, or move the running one on a step, and say where it is and
 * what it proposes. It never applies or dismisses a change: a person does, on the article. The
 * brand comes from the signed canvas token; the article from list_articles_due's articleId.
 */

export type ApiResult = { status: number; body: unknown };

const LIMIT = { prefix: "article_review_agent", burstLimit: 6, hourlyLimit: 60 };
/** One step from the chat: the slowest (research) takes about a minute. */
const STEP_MS = 70_000;

export const NOTE =
  "A refresh review reads the live article, opens its sources again, looks for newer research, reads the brand map, the brand's own material and the searches that land on the page, " +
  "then proposes changes, each tied to what it found. Nothing changes until a person applies them on the article (link). A real change to the words moves the article's Updated date; link fixes don't.";

export async function reviewAgentGate(req: Request): Promise<{ ok: true; ctx: TenantContext } | { ok: false; result: ApiResult }> {
  if (!isBlogRefreshChatEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  const ctx = tenantContextFromCanvasToken(verified.claims);
  if (await isRateLimited(`tenant:${ctx.tenantId}`, LIMIT)) return { ok: false, result: { status: 429, body: { error: "rate_limited" } } };
  return { ok: true, ctx };
}

const ArticleId = /^[A-Za-z0-9_-]{6,80}$/;

/** The live article's programme, from the freshness watch's pages (no plan is read to find it). */
async function articleOf(ctx: TenantContext, articleId: string, deps: { db?: FirestoreLike }): Promise<{ planId: string; workspaceId: string; title: string } | null> {
  const watch = await readFreshnessWatch(ctx, deps);
  const page = watch?.pages.find((p) => p.planId === articleId);
  if (!page) return null;
  return { planId: page.planId, workspaceId: page.workspaceId, title: watch?.due.find((d) => d.planId === articleId)?.title ?? "" };
}

function view(review: ArticleReviewDoc | null, article: { planId: string; workspaceId: string; title: string }, extra: { reviewsLeftThisMonth?: number; started?: boolean } = {}) {
  const evidence = new Map((review?.evidence ?? []).map((e) => [e.id, e] as const));
  const body = {
    articleId: article.planId,
    ...(article.title ? { title: article.title } : {}),
    review: review
      ? {
          state: review.state === "running" ? "running" : review.state === "ready" ? "ready for a person to look at" : review.state,
          ...(review.active && review.step ? { now: STEP_SAID[review.step] } : {}),
          startedBy: review.by,
          startedAt: review.startedAt,
          changesProposed: review.state === "ready" ? review.proposals.length : 0,
          changes:
            review.state === "ready"
              ? review.proposals.map((p) => ({
                  kind: KIND_SAID[p.kind],
                  replaces: p.old,
                  with: p.new,
                  why: p.why,
                  evidence: p.evidenceIds.map((id) => evidence.get(id)).filter((e) => Boolean(e)).map((e) => evidenceLine(e!)),
                  movesUpdated: p.real,
                }))
              : [],
          couldNotRead: review.notes,
        }
      : null,
    ...extra,
    link: refreshHref(article),
    note: NOTE,
  };
  return { ...body, meanings: meaningsOf(numberKeys(body)) };
}

/** Where the article's review is: GET. */
export async function agentReadReview(ctx: TenantContext, articleId: string, deps: { db?: FirestoreLike } = {}): Promise<ApiResult> {
  if (!ArticleId.test(articleId)) return { status: 400, body: { error: "invalid_input" } };
  const article = await articleOf(ctx, articleId, deps);
  if (!article) return { status: 404, body: { error: "not_found" } };
  return { status: 200, body: view(await readReview(ctx, article.planId, deps), article) };
}

/** Start a review, or move the running one a step: POST. */
export async function agentReviewArticle(ctx: TenantContext, raw: unknown, deps: ReviewDeps = {}): Promise<ApiResult> {
  const articleId = (raw as { articleId?: unknown } | null)?.articleId;
  if (typeof articleId !== "string" || !ArticleId.test(articleId)) return { status: 400, body: { error: "invalid_input" } };
  const article = await articleOf(ctx, articleId, deps);
  if (!article) return { status: 404, body: { error: "not_found" } };
  let review = await readReview(ctx, article.planId, deps);
  let started = false;
  let left: number | undefined;
  if (!review?.active) {
    const may = await mayStartReview(ctx, { db: deps.db, now: deps.now, loadTenant: deps.loadTenant });
    if (!may.ok) return { status: may.status, body: { error: may.error } };
    const plan = await getContentPlan(ctx, article.workspaceId, article.planId, deps.db);
    if (!plan) return { status: 404, body: { error: "not_found" } };
    if (autopilotHolds(plan)) return { status: 409, body: { error: "autopilot_running" } };
    const r = await startReview(ctx, { plan, by: "vizzy" }, deps);
    if (!r.ok) return { status: r.status, body: { error: r.error } };
    review = r.review;
    started = r.started;
    left = Math.max(0, may.limit - may.used - (r.started ? 1 : 0));
  }
  review = (await advanceReview(ctx, article.planId, { deadlineMs: Date.now() + STEP_MS }, deps)) ?? review;
  return { status: 200, body: view(review, article, { started, ...(left !== undefined ? { reviewsLeftThisMonth: left } : {}) }) };
}
