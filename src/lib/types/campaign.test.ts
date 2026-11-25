import { describe, expect, it } from "vitest";
import { defaultCampaignSettings } from "@/lib/admin/campaignSettings";
import { CampaignSchema, IDEA_LIMITS, IDEA_STATUSES, IdeaSchema } from "./campaign";

/** A launch as stored before ideas existed: no `idea` at all. */
const legacy = {
  ...defaultCampaignSettings(),
  id: "offline-mode",
  tenantId: "ten_A",
  waitlistName: "Offline mode",
  createdAt: "2026-10-01T09:00:00.000Z",
};

describe("a launch's idea", () => {
  it("is optional, so a launch made before ideas reads cleanly", () => {
    const parsed = CampaignSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.idea).toBeUndefined();
  });

  it("holds a hypothesis, a status with who and when, an outcome and a hand-off", () => {
    const idea = {
      hypothesis: "Teams will move their shared notes here if each space keeps its own members.",
      status: "launched",
      statusAt: "2026-11-18T10:00:00.000Z",
      statusBy: "usr_admin",
      outcome: "Validated on 27 Oct, launched on 10 Nov.",
      productConnectionId: "pcn_app",
      handedOffAt: "2026-11-18T10:00:00.000Z",
      handedOffBy: "usr_admin",
      justAList: false,
    };
    const parsed = CampaignSchema.safeParse({ ...legacy, idea });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.idea).toEqual(idea);
  });

  it("takes null for a cleared field", () => {
    expect(IdeaSchema.safeParse({ hypothesis: null, outcome: null, productConnectionId: null, handedOffAt: null }).success).toBe(true);
  });

  it("has six statuses, in order, and no other", () => {
    expect(IDEA_STATUSES).toEqual(["exploring", "testing", "validated", "launched", "parked", "killed"]);
    expect(IdeaSchema.safeParse({ status: "archived" }).success).toBe(false);
    expect(IdeaSchema.safeParse({ status: null }).success).toBe(false);
  });

  it("keeps a hypothesis to 500 characters and an outcome to 2,000", () => {
    expect(IDEA_LIMITS).toEqual({ hypothesis: 500, outcome: 2000 });
    expect(IdeaSchema.safeParse({ hypothesis: "a".repeat(500) }).success).toBe(true);
    expect(IdeaSchema.safeParse({ hypothesis: "a".repeat(501) }).success).toBe(false);
    expect(IdeaSchema.safeParse({ outcome: "a".repeat(2000) }).success).toBe(true);
    expect(IdeaSchema.safeParse({ outcome: "a".repeat(2001) }).success).toBe(false);
  });
});
