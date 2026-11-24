import { isBlogFreshnessEnabled } from "@/lib/brandMap/flags";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { meaningsOf, numberKeys } from "@/lib/metrics/meanings";
import { isRateLimited, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { readFreshnessWatch } from "./freshnessPages";
import { refreshHref } from "./freshnessHref";

/**
 * For Vizzy's list_articles_due (/api/agent/articles-due, BLOG_FRESHNESS_ENABLED): the brand's live
 * articles due, or soon due, a refresh, each with its clock and every reason, and how many live
 * articles are on each clock. Read from the freshness watch's daily record, never every plan.
 * Read only: a person opens the article to refresh it or mark it checked. The brand comes from
 * the signed canvas token.
 */

export type ApiResult = { status: number; body: unknown };

const LIMIT = { prefix: "articles_due_agent", burstLimit: 10, hourlyLimit: 120 };

export const NOTE =
  "YouGrow looks at each live blog article once a day. An article is due a refresh when it passes its clock (20, 30 or 45 days since it went live, was updated or was last checked) " +
  "or has a strong reason, such as falling Google clicks, a dead link or an old figure; review soon means within 5 days of its clock, or a weaker reason. " +
  "Clocks are spread across 20, 30 and 45 days to learn which works for the brand, unless an admin chose one on Brand map. A person opens the article to refresh it, or marks it checked.";

export async function articlesDueAgentGate(req: Request): Promise<{ ok: true; ctx: TenantContext } | { ok: false; result: ApiResult }> {
  if (!isBlogFreshnessEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  const ctx = tenantContextFromCanvasToken(verified.claims);
  if (await isRateLimited(`tenant:${ctx.tenantId}`, LIMIT)) return { ok: false, result: { status: 429, body: { error: "rate_limited" } } };
  return { ok: true, ctx };
}

export async function agentArticlesDue(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<ApiResult> {
  const watch = await readFreshnessWatch(ctx, deps);
  if (!watch) {
    return { status: 200, body: { lookedAt: null, articles: [], note: `${NOTE} The watch hasn't looked at this brand's live articles yet.`, meanings: {} } };
  }
  const body = {
    lookedAt: watch.updatedAt,
    articlesDue: watch.counts.due,
    articlesReviewSoon: watch.counts.soon,
    articlesFresh: watch.counts.fresh,
    byClock: (["20", "30", "45"] as const).map((c) => ({ clockDays: Number(c), liveArticles: watch.byClock[c] ?? 0 })),
    articles: watch.due.map((d) => ({
      title: d.title,
      liveAddress: d.url,
      state: d.state === "due" ? "due a refresh" : "review soon",
      dueAt: d.dueAt,
      clockDays: d.clockDays,
      reasons: d.reasons.map((r) => r.detail),
      link: refreshHref(d),
    })),
    note: NOTE,
  };
  return { status: 200, body: { ...body, meanings: meaningsOf(numberKeys(body)) } };
}
