import { forTenant } from "@/lib/tenant";
import type { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { nextUpDocId } from "@/lib/types/autopilot";
import { BlogArticleMetaSchema, type BlogArticleFreshness, type FreshnessReason } from "@/lib/types/contentPlan";
import type { FreshnessWatchDoc } from "@/lib/types/freshness";
import { freshnessWatchId } from "../freshnessPages";
import { sampleHub, samplePlan } from "./samplePlan";

/**
 * A made-up brand's live article as the freshness watch and Next up leave it: its Freshness card
 * and its row on the brand's due list each hold two reasons with Search Console's numbers in their
 * words beside one of the article's own, and Next up holds a refresh pick that weighed Search
 * Console beside one that didn't. Every page, number and name is made up.
 */

export const FRESH = {
  workspaceId: "ws_care",
  planId: "plan_fig",
  url: "https://fernhill.example/care/fiddle-leaf-fig",
  key: "fernhill.example/care/fiddle-leaf-fig",
  title: "How often should I water a fiddle leaf fig?",
} as const;

export const FRESH_REASONS: FreshnessReason[] = [
  { kind: "losing_clicks", detail: "41 clicks in the 28 days to 20 Nov, down from 96 in the 28 days before.", hard: true },
  { kind: "dead_link", detail: "1 link no longer opens", hard: true },
  { kind: "within_reach", detail: "Search Console: position 9 on average, 1,900 impressions in 28 days. A refresh could lift it onto page one.", hard: false },
];

/**
 * The brand's live, approved blog article at FRESH.url (published 20 Oct), in its own programme,
 * with the freshness given (none: the watch hasn't looked yet) and, optionally, its own body.
 */
export function seedLiveArticle(ctx: TenantContext, db: FakeFirestore, opts: { freshness?: BlogArticleFreshness; body?: string } = {}): void {
  db.seed("workspaces", FRESH.workspaceId, { tenantId: ctx.tenantId, name: "Plant care", createdAt: "2026-01-01T00:00:00.000Z" });
  const hub = sampleHub({
    status: "approved",
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    blog: {
      ...BlogArticleMetaSchema.parse({}),
      live: { url: FRESH.url, at: "2026-10-21T08:00:00.000Z", by: "check", titleMatched: true },
      dates: { published: { at: "2026-10-20", source: "page" } },
      ...(opts.freshness ? { freshness: opts.freshness } : {}),
    },
  });
  db.seed(
    `workspaces/${FRESH.workspaceId}/content_plans`,
    FRESH.planId,
    samplePlan({ id: FRESH.planId, tenantId: ctx.tenantId, workspaceId: FRESH.workspaceId, name: "Fiddle leaf fig care", strategy: { objective: "brand_visibility", hubUrl: FRESH.url } }, hub),
  );
}

/** The article above as the watch left it, with its row on the due list, and the brand's Next up. */
export async function seedFreshArticle(ctx: TenantContext, db: FakeFirestore, now: Date): Promise<void> {
  const at = now.toISOString();
  const dueAt = "2026-11-10T08:00:00.000Z";
  const freshness: BlogArticleFreshness = {
    clockDays: 20,
    arm: "test",
    assignedAt: "2026-10-21T08:00:00.000Z",
    checkedAt: null,
    state: "due",
    reasons: FRESH_REASONS,
    dueAt,
    sweptAt: at,
    deadLinks: ["https://gone.example.net/watering-chart"],
    linksCheckedAt: at,
    openAtStart: 3,
    events: [{ at, kind: "due", clockDays: 20 }],
  };
  seedLiveArticle(ctx, db, { freshness });
  const watch: Omit<FreshnessWatchDoc, "id" | "tenantId"> = {
    nextAt: new Date(now.getTime() + 86_400_000).toISOString(),
    counts: { fresh: 0, soon: 0, due: 1 },
    byClock: { "20": 1, "30": 0, "45": 0 },
    pages: [{ key: FRESH.key, planId: FRESH.planId, workspaceId: FRESH.workspaceId }],
    due: [{ planId: FRESH.planId, workspaceId: FRESH.workspaceId, title: FRESH.title, url: FRESH.url, state: "due", reasons: FRESH_REASONS, dueAt, clockDays: 20, subjectId: "sub_water0000000" }],
    linksDay: at.slice(0, 10),
    linksToday: 1,
    updatedAt: at,
  };
  await forTenant(ctx, db).freshnessWatch.create(freshnessWatchId(ctx.tenantId), watch);
  await forTenant(ctx, db).nextUp.upsert(
    nextUpDocId(ctx.tenantId),
    () => ({
      picks: [
        {
          questionId: `refresh:${FRESH.planId}`,
          question: FRESH.title,
          subjectId: "sub_water0000000",
          subjectName: "a live article",
          because: "Its page lost clicks: 41 in 28 days, down from 96.",
          chips: [{ kind: "num", label: "Search Console", text: "41 clicks in the 28 days to 20 Nov, down from 96" }],
          from: "gemini",
          kind: "refresh",
          planId: FRESH.planId,
          workspaceId: FRESH.workspaceId,
        },
        { questionId: "q_pets000000000000", question: "Which plants are safe for cats?", subjectId: "sub_pets00000000", subjectName: "Pet safe plants", because: "No article answers it yet.", chips: [{ kind: "map", label: "Brand map", text: "1 of 4 answered" }], from: "gemini" },
      ],
      notOnMap: [],
      missing: [],
      candidates: 2,
      at,
      by: "schedule",
    }),
    () => null,
  );
}
