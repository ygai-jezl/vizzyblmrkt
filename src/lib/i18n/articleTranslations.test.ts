import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { forgetPlanTranslations } from "./articleTranslations";

/** An article's versions in other languages (PAGE_LANGUAGES_ENABLED). */

const A = { tenantId: "ten_A", region: "us", source: "system" } as TenantContext;

describe("deleting a plan", () => {
  it("removes its article versions, and nobody else's", async () => {
    const db = new FakeFirestore();
    db.seed("translations", "tra_plan1_hub_fr", { tenantId: "ten_A", kind: "article", planId: "plan1", lang: "fr" });
    db.seed("translations", "tra_plan2_hub_fr", { tenantId: "ten_A", kind: "article", planId: "plan2", lang: "fr" });
    db.seed("translations", "tra_plan1_hub_de", { tenantId: "ten_B", kind: "article", planId: "plan1", lang: "de" });
    await forgetPlanTranslations(A, "plan1", db as unknown as FirestoreLike);
    expect(db.raw("translations", "tra_plan1_hub_fr")).toBeUndefined();
    expect(db.raw("translations", "tra_plan2_hub_fr")).toBeTruthy();
    expect(db.raw("translations", "tra_plan1_hub_de")).toBeTruthy();
  });
});
