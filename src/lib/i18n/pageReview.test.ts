import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { samplePlan } from "@/lib/content/blog/testing/samplePlan";
import { pageTranslationReviewItems } from "./pageReview";

/** Review's Pages in other languages (PAGE_LANGUAGES_ENABLED). */

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" } as TenantContext;
const AT = "2026-11-28T09:00:00.000Z";

function on() {
  for (const n of ["PAGE_LANGUAGES_ENABLED", "ASSET_TRANSLATIONS_ENABLED", "LANGUAGE_READERS_ENABLED", "CONTENT_LANGUAGE_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED"]) vi.stubEnv(n, "true");
}
beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

function world() {
  const db = new FakeFirestore();
  db.seed("workspaces/ws1/content_plans", "plan_1", samplePlan());
  db.seed("campaigns", "camp1", { tenantId: "ten_A", waitlistName: "Fernlight", archivedAt: null });
  const common = { tenantId: "ten_A", from: "en", state: "to_check", rev: 2, sourceHash: "h", failReason: null, leaseUntil: null, createdAt: AT, updatedAt: AT };
  db.seed("translations", "tra_plan_1_hub_fr", { ...common, kind: "article", workspaceId: "ws1", planId: "plan_1", nodeId: "hub", lang: "fr" });
  db.seed("translations", "tra_plan_1_hub_de", { ...common, kind: "article", workspaceId: "ws1", planId: "plan_1", nodeId: "hub", lang: "de" });
  db.seed("translations", "trl_camp1_fr", { ...common, kind: "launch_copy", campaignId: "camp1", lang: "fr" });
  db.seed("translations", "tr_j_p_e_fr", { ...common, kind: "journey_email", journeyId: "j", poolId: "p", itemId: "e", lang: "fr" });
  return db as unknown as FirestoreLike;
}

describe("Pages in other languages", () => {
  it("lists one row per article and per sign-up page, never journey emails, with Approve all for admins", async () => {
    on();
    const rows = await pageTranslationReviewItems(admin, world());
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "page_translation",
        title: "Article · Visibility guide",
        detail: "Deutsch, Français to check",
        href: "/admin/workspace/ws1/create/plan_1",
        approveLanguages: { endpoint: "/api/admin/workspace/ws1/content-plans/plan_1/translations", revs: { tra_plan_1_hub_fr: 2, tra_plan_1_hub_de: 2 } },
      }),
      expect.objectContaining({ title: "Sign-up page · Fernlight", href: "/admin/launches/camp1/settings", approveLanguages: { endpoint: "/api/admin/campaigns/camp1/translations", revs: { trl_camp1_fr: 2 } } }),
    ]);
  });

  it("gives a member no Approve all, and nothing while the switch is off", async () => {
    on();
    const rows = await pageTranslationReviewItems({ ...admin, role: "member" } as TenantContext, world());
    expect(rows.every((r) => !r.approveLanguages)).toBe(true);
    vi.unstubAllEnvs();
    expect(await pageTranslationReviewItems(admin, world())).toEqual([]);
  });
});
