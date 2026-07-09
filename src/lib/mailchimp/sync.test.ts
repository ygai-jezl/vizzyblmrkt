import { describe, it, expect } from "vitest";
import { campaignTag, weeklyTag } from "./sync";

describe("audience tags", () => {
  it("derives stable, distinct per-launch tags", () => {
    expect(campaignTag("camp1")).toBe("waitlist-camp1");
    expect(weeklyTag("camp1")).toBe("weekly-camp1");
    // The two segments must never collide — the weekly opt-in is a strict subset.
    expect(weeklyTag("camp1")).not.toBe(campaignTag("camp1"));
  });
});
