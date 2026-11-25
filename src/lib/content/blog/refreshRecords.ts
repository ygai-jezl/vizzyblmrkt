import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ArticleReviewDoc, ProposalKind, RefreshRecord } from "@/lib/types/articleRefresh";

/**
 * One record per refresh review (BLOG_REFRESH_ENABLED), `rr_<reviewId>`, in the learning loops'
 * record shape: what was seen when it started, what it proposed, what was decided, what it cost,
 * and (28 days after, src/lib/content/blog/refreshOutcome.ts) what came of it. Each section is
 * written once, by code. The records count reviews against the brand's monthly cap and feed the
 * clock readout. They hold no copy, only counts, dates and the article's address.
 */

export const recordId = (reviewId: string) => `rr_${reviewId}`;

/**
 * An estimate of what a review cost Google, in US cents, at list prices from 1 January 2027 (the
 * AI credits research, 20 Nov 2026): web searches for research at $14 per 1,000, and model tokens
 * at about $2.40 per million (Flash, mostly input). Only ever shown as an estimate.
 */
export const COST_CENTS = { perSearch: 1.4, perThousandTokens: 0.24 } as const;
export const costCents = (spent: { searches: number; tokens: number }) =>
  Math.round((spent.searches * COST_CENTS.perSearch + (spent.tokens / 1000) * COST_CENTS.perThousandTokens) * 10) / 10;

interface RecordDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

const repoOf = (ctx: TenantContext, deps: RecordDeps) => forTenant(ctx, deps.db).refreshRecords;

/** The review started: what was seen. Written once. */
export async function recordStart(ctx: TenantContext, review: ArticleReviewDoc, deps: RecordDeps = {}): Promise<void> {
  await repoOf(ctx, deps)
    .upsert(
      recordId(review.reviewId),
      () => ({
        reviewId: review.reviewId,
        planId: review.planId,
        workspaceId: review.workspaceId,
        month: review.month,
        startedAt: review.startedAt,
        by: review.by,
        observation: { ...review.why, liveUrl: null },
        proposal: null,
        decision: null,
        cost: null,
        outcome: null,
      }),
      () => null,
    )
    .catch((err) => console.warn("[refresh] record start failed:", err instanceof Error ? err.message.slice(0, 120) : "error"));
}

/** What the review proposed (none, for "nothing"). Written once. */
export async function recordProposals(ctx: TenantContext, review: ArticleReviewDoc, deps: RecordDeps = {}): Promise<void> {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const kinds: Partial<Record<ProposalKind, number>> = {};
  for (const p of review.proposals) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
  await repoOf(ctx, deps)
    .claim(recordId(review.reviewId), (cur) =>
      cur.proposal ? null : { proposal: { count: review.proposals.length, kinds, at }, observation: { ...cur.observation, liveUrl: review.reading?.liveUrl ?? null } },
    )
    .catch(() => null);
}

/** What was decided, and what the review cost by then. Written once. */
export async function recordDecision(
  ctx: TenantContext,
  review: Pick<ArticleReviewDoc, "reviewId" | "spent">,
  decision: { outcome: NonNullable<RefreshRecord["decision"]>["outcome"]; accepted: number; real: boolean; byUid: string | null },
  deps: RecordDeps = {},
): Promise<void> {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  await repoOf(ctx, deps)
    .claim(recordId(review.reviewId), (cur) =>
      cur.decision ? null : { decision: { ...decision, at }, cost: { ...review.spent, cents: costCents(review.spent) } },
    )
    .catch(() => null);
}

/** Reviews started this month, against the article_refresh cap. */
export async function reviewsThisMonth(ctx: TenantContext, deps: RecordDeps = {}): Promise<number> {
  const month = (deps.now ?? (() => new Date()))().toISOString().slice(0, 7);
  const rows = await repoOf(ctx, deps).find({ where: [["month", "==", month]], limit: 1000 });
  return rows.length;
}

/** The brand's records, newest first, for the readout. */
export async function listRecords(ctx: TenantContext, deps: RecordDeps = {}, limit = 500): Promise<RefreshRecord[]> {
  const rows = await repoOf(ctx, deps).find({ limit });
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
