import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { isPageLanguagesEnabled } from "@/lib/i18n/flags";
import { isArticleTranslation } from "@/lib/types/translation";
import { hreflangOf } from "./languageTags";
import { pageMatches, type PageReader } from "./live";
import { outlineArticle } from "./outline";

/**
 * Found live for an article's versions in other languages (PAGE_LANGUAGES_ENABLED): a version with
 * an address, approved or waiting to be checked, is looked for there, matched against its own
 * words. Found, it records which language links its page is missing (Google ignores the whole set
 * when one is), and opens the default language's page once to see that it lists this version too.
 * A version a person put live while it was still to check is approved, as the default is.
 */

export interface VersionBudget {
  canOpen: () => boolean;
  open: () => void;
}

export interface VersionPass {
  opened: number;
  found: number;
  approved: number;
  /** Versions still to be found: the watch comes back for them. */
  waiting: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function checkVersions(ctx: TenantContext, budget: VersionBudget, deps: { db?: FirestoreLike; read: PageReader; nowMs: number }): Promise<VersionPass> {
  const pass: VersionPass = { opened: 0, found: 0, approved: 0, waiting: 0 };
  if (!isPageLanguagesEnabled()) return pass;
  const repo = forTenant(ctx, deps.db).translations;
  const all = (await repo.find({ where: [["kind", "==", "article"]], limit: 200 })).filter(isArticleTranslation);
  const waiting = all.filter((t) => t.address && !t.live && (t.state === "approved" || (t.state === "to_check" && t.draft)));
  pass.waiting = waiting.length;
  for (const t of waiting) {
    if (!budget.canOpen()) break;
    budget.open();
    pass.opened += 1;
    const words = t.state === "approved" && t.approved ? t.approved.fields : t.draft!.fields;
    const page = await deps.read(t.address!).catch(() => null);
    if (!page || page.refused) continue;
    const titles = [outlineArticle(words.body).title ?? "", words.metaTitle].filter((x) => x.trim());
    if (!pageMatches(page, { titles, body: words.body }).matched) continue;
    pass.found += 1;
    pass.waiting -= 1;
    // Each version lists itself, every other approved version with an address, the default and x-default.
    const siblings = all.filter((s) => s.planId === t.planId && s.approved && s.address).map((s) => s.lang);
    const expected = [...new Set([t.from, t.lang, ...siblings].map((c) => hreflangOf(c).toLowerCase())), "x-default"];
    const have = new Set((page.alternates ?? []).map((a) => a.hreflang.toLowerCase()));
    const missingTags = expected.filter((c) => !have.has(c)).slice(0, 30);
    // The default page's return link: one more page, when the budget has it.
    let fromDefault: boolean | undefined;
    const plan = await getContentPlan(ctx, t.workspaceId, t.planId, deps.db).catch(() => null);
    const baseUrl = plan?.strategy.hubUrl?.trim();
    if (baseUrl && budget.canOpen()) {
      budget.open();
      pass.opened += 1;
      const basePage = await deps.read(baseUrl).catch(() => null);
      if (basePage && !basePage.refused) fromDefault = (basePage.alternates ?? []).some((a) => a.hreflang.toLowerCase() === hreflangOf(t.lang).toLowerCase());
    }
    const at = iso(deps.nowMs);
    let approved = false;
    await repo.claim(t.id, (cur) => {
      if (!isArticleTranslation(cur) || cur.address !== t.address) return null;
      approved = cur.state === "to_check" && Boolean(cur.draft);
      return {
        live: { url: t.address!, at, checkedAt: at, missingTags, ...(fromDefault !== undefined ? { fromDefault } : {}) },
        ...(approved && cur.draft ? { state: "approved" as const, approved: { ...cur.draft, from: cur.from, approvedBy: "found_live", approvedAt: at }, draft: null } : {}),
        rev: cur.rev + 1,
        updatedAt: at,
      };
    });
    if (approved) pass.approved += 1;
  }
  return pass;
}
