import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsertMember } = vi.hoisted(() => ({ upsertMember: vi.fn() }));
vi.mock("./client", () => ({ upsertMember, archiveMember: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getTenantById: vi.fn(async () => ({ id: "ten_A" })) }));
vi.mock("./config", () => ({
  resolveMailchimpConfig: () => ({ ok: true, config: { apiKey: "k-us1", serverPrefix: "us1", audienceId: "aud", source: "shared" } }),
}));

import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import { syncSignupToAudience, syncSignupToWeekly } from "./sync";

const ctx = { tenantId: "ten_A", region: "us" as const, source: "system" as const };
const campaign = { id: "news" } as Campaign;
const signup = { email: "sam@example.com", amountReferred: 0 } as Signup;
const compliance = { ok: false, reason: "Member In Compliance State" };

beforeEach(() => upsertMember.mockReset());

describe("adding someone back after they unsubscribed in Mailchimp", () => {
  it("asks Mailchimp to confirm them (pending) when it won't set them back to subscribed", async () => {
    upsertMember.mockResolvedValueOnce(compliance).mockResolvedValueOnce({ ok: true });
    expect(await syncSignupToWeekly(ctx, campaign, signup, { resubscribe: true })).toEqual({ ok: true });
    expect(upsertMember).toHaveBeenCalledTimes(2);
    expect(upsertMember.mock.calls[1]![1]).toMatchObject({ status: "pending", tags: ["weekly-news"] });
  });

  it("never does that without resubscribe: today's sync is unchanged", async () => {
    upsertMember.mockResolvedValueOnce(compliance);
    expect(await syncSignupToAudience(ctx, campaign, signup)).toEqual(compliance);
    expect(upsertMember).toHaveBeenCalledTimes(1);
    expect(upsertMember.mock.calls[0]![1]).toMatchObject({ status: "subscribed", tags: ["waitlist-news"] });
  });

  it("only for Mailchimp's compliance refusal", async () => {
    upsertMember.mockResolvedValueOnce({ ok: false, reason: "http_500" });
    expect(await syncSignupToAudience(ctx, campaign, signup, { resubscribe: true })).toEqual({ ok: false, reason: "http_500" });
    expect(upsertMember).toHaveBeenCalledTimes(1);
  });
});
