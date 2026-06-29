import { describe, it, expect } from "vitest";
import { buildSharePayload } from "./postSignup";
import type { TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";

// An "unverified" signup skips rank computation, so buildSharePayload never
// touches the tenant context — we can pass an empty stub and assert the
// share-message rendering end-to-end (the surface this product-name field exists
// to fix: the post-signup social share sentence).
const ctx = {} as TenantContext;

const signup = {
  id: "s1",
  status: "unverified",
  amountReferred: 0,
  referralLink: "https://x.test/r/abc",
} as unknown as Signup;

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "c1",
    tenantId: "ten_x",
    waitlistName: "Be the first to get access", // a CTA-style headline
    hideCounts: false,
    configurationStyleJson: { shareMessage: "I just joined {{waitlist_name}}!" },
    ...overrides,
  } as unknown as Campaign;
}

describe("buildSharePayload — share message names the product", () => {
  it("renders {{waitlist_name}} as the product name, not the headline", async () => {
    const payload = await buildSharePayload(ctx, campaign({ productName: "Acme Pro" }), signup);
    expect(payload.shareMessage).toBe("I just joined Acme Pro!");
    expect(payload.shareMessage).not.toContain("Be the first to get access");
  });

  it("falls back to the waitlist name when productName is unset", async () => {
    const payload = await buildSharePayload(ctx, campaign(), signup);
    expect(payload.shareMessage).toBe("I just joined Be the first to get access!");
  });
});
