import { computeHybridEmailAnalytics, computeHybridSequenceBreakdown } from "@/lib/analytics/email";
import { journeyIdFor } from "@/lib/journey/service";
import { isWaitlistAbWinnerEnabled } from "@/lib/lifecycle/waitlist/flags";
import { summariseEmailSends, type SendTotals } from "@/lib/email/sends";
import { loadEmailInsights } from "@/lib/insights/email";
import { journeyAnalytics } from "@/lib/lifecycle/adminApi";
import { listPostPerformance } from "@/lib/tenant/postPerformance";
import type { TenantContext } from "@/lib/tenant/types";
import type { PostPerformance } from "@/lib/types/postPerformance";
import { meaningsOf, numberKeys } from "./meanings";

/**
 * The numbers Vizzy reads about a brand's emails and posts (RESULTS_CHAT_ENABLED), built from the
 * same analytics the screens use, each response carrying the meaning of every number in it.
 * Aggregates only: never a person, never an address. Read only.
 */

export type ApiResult = { status: number; body: unknown };
export type EmailScope = "overview" | "launch" | "journey";

const withMeanings = (body: Record<string, unknown>): ApiResult => ({ status: 200, body: { ...body, meanings: meaningsOf(numberKeys(body)) } });

const detailOf = ({ totals, complete }: { totals: SendTotals; complete: boolean }) => ({
  note: "From each email's send record: only emails sent or answered after full email detail was turned on.",
  complete,
  ...totals,
});

/**
 * Each email of a launch's welcome sequence that runs an A/B test (WAITLIST_AB_WINNER_ENABLED):
 * its versions and the winner a person picked, read from the breakdown the Analytics tab shows,
 * on whichever engine the launch sends from.
 */
async function emailTests(ctx: TenantContext, launchId: string) {
  const { nodes } = await computeHybridSequenceBreakdown(ctx, journeyIdFor(launchId));
  return nodes
    .filter((n) => n.abTest)
    .map((n) => {
      const winner = n.status === "promoted" ? n.arms.find((a) => a.variantId === n.winnerVariantId) : undefined;
      return {
        email: n.label,
        winnerPicked: n.status === "promoted",
        winner: winner?.label ?? null,
        versions: n.arms.map((a) => ({
          version: a.label,
          sends: a.sent,
          delivered: a.delivered,
          uniqueOpens: a.opened,
          uniqueClicks: a.clicked,
          unsubscribes: a.unsubscribed,
          openRate: a.openRate,
          clickRate: a.clickRate,
        })),
      };
    });
}

export async function emailResults(ctx: TenantContext, args: { scope: EmailScope; id?: string }): Promise<ApiResult> {
  if (args.scope === "overview") {
    const [insights, detail] = await Promise.all([loadEmailInsights(ctx, { lifecycle: true, invites: true }), summariseEmailSends(ctx, {})]);
    return withMeanings({
      scope: "overview",
      period: insights.basis,
      programmes: insights.programmes.map((p) => ({ name: p.name, link: p.href, sends: p.sends, openRate: p.openRate, clickRate: p.clickRate })),
      broadcasts: insights.broadcasts.map((b) => ({ name: b.name, sentAt: b.sentAt, sends: b.sends, openRate: b.openRate, clickRate: b.clickRate })),
      detail: detailOf(detail),
    });
  }
  if (!args.id) return { status: 400, body: { error: "id_required" } };
  if (args.scope === "launch") {
    const [a, detail, tests] = await Promise.all([
      computeHybridEmailAnalytics(ctx, args.id),
      summariseEmailSends(ctx, { campaignId: args.id }),
      isWaitlistAbWinnerEnabled() ? emailTests(ctx, args.id) : null,
    ]);
    return withMeanings({
      scope: "launch",
      launch: args.id,
      overall: { sends: a.cards.sends, deliveryRate: a.cards.deliveryRate, openRate: a.cards.openRate, clickRate: a.cards.clickRate },
      sequences: a.sequences.map((r) => ({
        name: r.name,
        people: r.enrolled,
        sends: r.sent,
        delivered: r.delivered,
        uniqueOpens: r.opened,
        uniqueClicks: r.clicked,
        unsubscribes: r.unsubscribed,
        openRate: r.openRate,
        clickRate: r.clickRate,
      })),
      broadcasts: a.broadcasts.map((b) => ({ name: b.name, people: b.enrolled, delivered: b.delivered, openRate: b.openRate, clickRate: b.clickRate, unsubscribes: b.unsubscribed, pending: b.pending })),
      ...(tests ? { emailTests: tests } : {}),
      partial: a.truncated,
      detail: detailOf(detail),
    });
  }
  const j = await journeyAnalytics(ctx, args.id);
  if (j.status !== 200) return j;
  const items = ((j.body as { items?: Array<Record<string, unknown>> }).items ?? []).map((i) => ({
    step: String(i.label ?? i.itemId ?? ""),
    sends: Number(i.sent ?? 0),
    uniqueOpens: Number(i.opens ?? 0),
    uniqueClicks: Number(i.clicks ?? 0),
    unsubscribes: Number(i.unsubscribes ?? 0),
    hardBounces: Number(i.bounces ?? 0),
    complaints: Number(i.complaints ?? 0),
  }));
  const detail = await summariseEmailSends(ctx, { journeyId: args.id });
  return withMeanings({ scope: "journey", journey: args.id, steps: items, detail: detailOf(detail) });
}

const POST_CHANNELS = ["linkedin", "x"] as const;

function postView(p: PostPerformance) {
  const raw = p.measurement?.metrics ?? p.snapshots[p.snapshots.length - 1]?.raw;
  return {
    channel: p.channel,
    post: p.sourcePostId,
    publishedAt: p.publishedAt ?? null,
    excerpt: (p.body ?? "").slice(0, 160),
    settled: p.rewardStatus !== "collecting",
    ...(raw
      ? {
          impressions: raw.impressions,
          likes: raw.likes,
          comments: raw.comments,
          shares: raw.shares,
          ...(raw.clicks != null ? { clicks: raw.clicks } : {}),
          ...(raw.reposts != null ? { reposts: raw.reposts } : {}),
          ...(raw.quotes != null ? { quotes: raw.quotes } : {}),
          ...(raw.bookmarks != null ? { bookmarks: raw.bookmarks } : {}),
          ...(raw.engagement != null ? { linkedinEngagement: raw.engagement } : {}),
        }
      : {}),
    ...(p.measurement ? { engagementRate: p.measurement.ER } : {}),
  };
}

export async function postResults(ctx: TenantContext, args: { channel?: "linkedin" | "x"; days: number; post?: string }): Promise<ApiResult> {
  const days = Math.max(1, Math.min(Math.round(args.days), 365));
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const channels = args.channel ? [args.channel] : [...POST_CHANNELS];
  const lists = await Promise.all(channels.map((channel) => listPostPerformance(ctx, { channel, sinceIso, limit: 100 })));
  let posts = lists.flat().map(postView);
  if (args.post) posts = posts.filter((p) => p.post === args.post);
  const totals = channels.map((channel) => {
    const mine = posts.filter((p) => p.channel === channel);
    const settled = mine.filter((p) => typeof p.engagementRate === "number");
    return {
      channel,
      posts: mine.length,
      impressions: mine.reduce((n, p) => n + (p.impressions ?? 0), 0),
      likes: mine.reduce((n, p) => n + (p.likes ?? 0), 0),
      comments: mine.reduce((n, p) => n + (p.comments ?? 0), 0),
      shares: mine.reduce((n, p) => n + (p.shares ?? 0), 0),
      ...(settled.length ? { engagementRate: settled.reduce((n, p) => n + (p.engagementRate ?? 0), 0) / settled.length } : {}),
    };
  });
  return withMeanings({ period: `last ${days} days`, totals, posts: posts.slice(0, 50) });
}
