import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import type { ReviewItem } from "@/lib/review/summary";
import { isArticleTranslation, isLaunchCopyTranslation, type Translation } from "@/lib/types/translation";
import { isPageLanguagesEnabled } from "./flags";
import { localeInfo } from "./locale";

/**
 * Review's "Pages in other languages" (PAGE_LANGUAGES_ENABLED): one row per article and per sign-up
 * page with translations to check, with Approve all languages for admins (each at the rev listed).
 */

function grouped<T extends Translation>(rows: T[], keyOf: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of rows) out.set(keyOf(t), [...(out.get(keyOf(t)) ?? []), t]);
  return out;
}

const detailOf = (rows: Translation[]) => `${[...new Set(rows.map((t) => localeInfo(t.lang).nativeName))].sort().join(", ")} to check`;
const revsOf = (rows: Translation[]) => Object.fromEntries(rows.map((t) => [t.id, t.rev]));

export async function pageTranslationReviewItems(ctx: TenantContext, db?: FirestoreLike): Promise<ReviewItem[]> {
  if (!isPageLanguagesEnabled()) return [];
  const repo = forTenant(ctx, db);
  const toCheck = await repo.translations.find({ where: [["state", "==", "to_check"]], limit: 200 });
  const admin = ctx.role === "admin";
  const items: ReviewItem[] = [];
  for (const [planId, rows] of grouped(toCheck.filter(isArticleTranslation), (t) => t.planId)) {
    const workspaceId = rows[0]!.workspaceId;
    const plan = await getContentPlan(ctx, workspaceId, planId, db).catch(() => null);
    if (!plan || plan.status === "archived") continue;
    items.push({
      id: `page_article_${planId}`,
      kind: "page_translation",
      title: `Article · ${plan.name}`,
      detail: detailOf(rows),
      href: `/admin/workspace/${workspaceId}/create/${planId}`,
      action: "Open",
      ...(admin ? { approveLanguages: { endpoint: `/api/admin/workspace/${workspaceId}/content-plans/${planId}/translations`, revs: revsOf(rows) } } : {}),
    });
  }
  for (const [campaignId, rows] of grouped(toCheck.filter(isLaunchCopyTranslation), (t) => t.campaignId)) {
    const campaign = await repo.campaigns.getById(campaignId).catch(() => null);
    if (!campaign || campaign.archivedAt) continue;
    items.push({
      id: `page_launch_${campaignId}`,
      kind: "page_translation",
      title: `Sign-up page · ${campaign.waitlistName}`,
      detail: detailOf(rows),
      href: `/admin/launches/${campaignId}/settings`,
      action: "Open",
      ...(admin ? { approveLanguages: { endpoint: `/api/admin/campaigns/${campaignId}/translations`, revs: revsOf(rows) } } : {}),
    });
  }
  return items;
}
