import { isRateLimited, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { isInsightsHubEnabled } from "@/lib/nav/flags";
import { loadInsightsOverview, sourcesNote } from "./overview";
import { loadEmailInsights } from "./email";

/**
 * What Vizzy may READ to answer "what drove signups this week?" (nav v2 phase 4
 * follow-up): the Insights numbers as aggregates — weekly signups, where they came
 * from, how each automated email does, activation and the waitlist → product
 * funnel. Never a person, an address or a single event. Auth is the signed canvas
 * capability token (the tenant comes from it), gated by the Insights hub flag.
 */

export type ApiResult = { status: number; body: unknown };

/** One summary is ~20 count() reads (BigQuery results are cached); plenty for a chat. */
const SUMMARY_LIMIT = { prefix: "insights_agent", burstLimit: 10, hourlyLimit: 120 };
const TOP_EMAILS = 10;

export function insightsAgentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isInsightsHubEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

const rate = (n: number | null) => (n == null ? null : Math.round(n * 1000) / 1000);

export async function agentInsightsSummary(
  ctx: TenantContext,
  opts: { lifecycle: boolean; invites: boolean; now?: Date },
  db?: FirestoreLike,
): Promise<ApiResult> {
  if (await isRateLimited(`tenant:${ctx.tenantId}`, SUMMARY_LIMIT, { db })) {
    return { status: 429, body: { error: "rate_limited" } };
  }
  const now = opts.now ?? new Date();
  const [o, email] = await Promise.all([
    loadInsightsOverview(ctx, { ...opts, now }, db),
    loadEmailInsights(ctx, opts, db).catch(() => null),
  ]);
  const weekly = o.weeks.map((w) => ({ weekStart: w.start, signups: w.signups }));
  return {
    status: 200,
    body: {
      generatedAt: now.toISOString(),
      // The four Insights tiles, as the operator sees them.
      headline: o.tiles.map((t) => ({ label: t.label, value: t.value, hint: t.hint })),
      signups: {
        thisWeek: weekly.at(-1)?.signups ?? null,
        lastWeek: weekly.at(-2)?.signups ?? null,
        weekly,
        note: "rolling 7-day windows, oldest first; the last one ends now",
      },
      sources: {
        basis: o.sources.basis,
        note: sourcesNote(o.sources),
        total: o.sources.total,
        rows: o.sources.rows.map((r) => ({ source: r.key, label: r.label, signups: r.count, content: r.content })),
        contentCampaigns: o.sources.contentCampaigns.map((c) => ({ utmCampaign: c.value, signups: c.count })),
      },
      email: {
        basis: email?.basis ?? null,
        bestByClickRate: o.bestEmail
          ? { name: o.bestEmail.name, clickRate: rate(o.bestEmail.clickRate), sends: o.bestEmail.sends, window: "last 30 days" }
          : null,
        programmes: (email?.programmes ?? []).slice(0, TOP_EMAILS).map((p) => ({
          name: p.name,
          sends: p.sends,
          openRate: rate(p.openRate),
          clickRate: rate(p.clickRate),
        })),
        broadcasts: (email?.broadcasts ?? []).slice(0, 5).map((b) => ({
          name: b.name,
          sentAt: b.sentAt,
          sends: b.sends,
          openRate: rate(b.openRate),
          clickRate: rate(b.clickRate),
        })),
        note: "open and click rates count people, not repeat opens",
      },
      funnel: o.funnel,
    },
  };
}
