import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import { createSignup } from "./signupService";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: "camp1",
    tenantId: "ten_A",
    waitlistName: "Beta",
    waitlistUrlLocation: null,
    spotsToMoveUponReferral: 10,
    usesFirstnameLastname: false,
    usesLeaderboard: true,
    usesSignupVerification: false,
    hideCounts: false,
    removeWidgetHeaders: false,
    requiredContactDetail: "EMAIL",
    questions: [],
    sendEmailCongratulationsOnReferral: true,
    leaderboardLength: 5,
    configurationStyleJson: {},
    createdAt: "2026-06-15T16:00:00Z",
    ...over,
  };
}

const opts = (db: FakeFirestore) => ({
  db,
  hostedPageBaseUrl: "https://example.test",
  now: "2026-06-15T16:00:00Z",
});

describe("createSignup", () => {
  it("creates a signup with server-controlled fields", async () => {
    const db = new FakeFirestore();
    const { signup, alreadyJoined, totalSignups } = await createSignup(
      ctx,
      campaign(),
      { email: "Maya@Example.com" },
      opts(db),
    );

    expect(alreadyJoined).toBe(false);
    expect(totalSignups).toBe(1);
    expect(signup.tenantId).toBe("ten_A");
    expect(signup.email).toBe("maya@example.com"); // normalized
    expect(signup.status).toBe("verified_active"); // no verification required
    expect(signup.verified).toBe(true);
    expect(signup.amountReferred).toBe(0);
    expect(signup.score).toBe(0); // 0 referrals * 10
    expect(signup.referralToken).toMatch(/^[A-Z0-9]{9}$/);
    expect(signup.referralLink).toContain(`ref=${signup.referralToken}`);
  });

  it("is idempotent for the same email (returns the existing signup)", async () => {
    const db = new FakeFirestore();
    const first = await createSignup(ctx, campaign(), { email: "a@b.com" }, opts(db));
    const second = await createSignup(ctx, campaign(), { email: "A@B.com" }, opts(db));

    expect(second.alreadyJoined).toBe(true);
    expect(second.signup.referralToken).toBe(first.signup.referralToken);
    expect(second.totalSignups).toBe(1); // not double-counted
  });

  it("marks signups unverified when the campaign requires verification", async () => {
    const db = new FakeFirestore();
    const { signup } = await createSignup(
      ctx,
      campaign({ usesSignupVerification: true }),
      { email: "c@d.com" },
      opts(db),
    );
    expect(signup.status).toBe("unverified");
    expect(signup.verified).toBe(false);
    expect(signup.verificationToken).toBeTruthy();
  });

  it("has no verification token when verification is not required", async () => {
    const db = new FakeFirestore();
    const { signup } = await createSignup(ctx, campaign(), { email: "n@o.com" }, opts(db));
    expect(signup.verificationToken).toBeNull();
  });

  it("uses the campaign's waitlist URL for the referral link when set", async () => {
    const db = new FakeFirestore();
    const { signup } = await createSignup(
      ctx,
      campaign({ waitlistUrlLocation: "https://brand.example/join" }),
      { email: "e@f.com" },
      opts(db),
    );
    expect(signup.referralLink).toMatch(/^https:\/\/brand\.example\/join\?ref=/);
  });

  it("persists mapped answers with their optional flag", async () => {
    const db = new FakeFirestore();
    const c = campaign({
      questions: [
        { question_value: "Role?", optional: false, answer_value: ["Eng", "PM"] },
      ],
    });
    const { signup } = await createSignup(
      ctx,
      c,
      { email: "g@h.com", answers: [{ question_value: "Role?", answer_value: "Eng" }] },
      opts(db),
    );
    expect(signup.answers).toEqual([
      { question_value: "Role?", optional: false, answer_value: "Eng" },
    ]);
  });
});
