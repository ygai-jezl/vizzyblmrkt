import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

const { db, verifySignupByToken, afterVerify } = vi.hoisted(() => ({
  db: { current: null as unknown },
  verifySignupByToken: vi.fn(async () => ({ status: "verified", referralToken: "REF", referredBySignupToken: null })),
  afterVerify: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tenant", async (orig) => {
  const actual = await orig<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    resolveTenantForRequest: async () => ({ tenantId: "ten_A", region: "us", source: "tenant_param" }),
    forTenant: (ctx: Parameters<typeof actual.forTenant>[0]) => actual.forTenant(ctx, db.current as never),
    verifySignupByToken,
    creditReferral: vi.fn(),
  };
});
vi.mock("@/lib/waitlist/afterVerify", () => ({ afterVerify }));

import { GET } from "./route";

function seed(joinedVia: "site" | null) {
  const fake = new FakeFirestore();
  fake.seed("campaigns", "news", { tenantId: "ten_A", waitlistName: "Acme newsletter", createdAt: "2026-10-01T00:00:00Z" });
  fake.seed("signups", "su1", {
    tenantId: "ten_A",
    campaignId: "news",
    email: "sam@example.com",
    status: "unverified",
    verificationToken: "tok123",
    ...(joinedVia ? { joinedVia } : {}),
    createdAt: "2026-10-22T09:00:00Z",
  });
  db.current = fake;
}

const get = () =>
  GET(new Request("https://yougrow.test/api/waitlist/news/verify?token=tok123&t=ten_A"), { params: Promise.resolve({ campaignId: "news" }) });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("the confirmation link (GET verify)", () => {
  it("sends a site sign-up to the Confirm subscription page, confirming nothing", async () => {
    vi.stubEnv("LAUNCH_SITE_SIGNUPS_ENABLED", "true");
    seed("site");
    const res = await get();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/waitlist/news/confirm?token=tok123&t=ten_A");
    expect(verifySignupByToken).not.toHaveBeenCalled();
  });

  it("confirms a form sign-up on the click, as before", async () => {
    vi.stubEnv("LAUNCH_SITE_SIGNUPS_ENABLED", "true");
    seed(null);
    const res = await get();
    expect(verifySignupByToken).toHaveBeenCalledTimes(1);
    expect(afterVerify).toHaveBeenCalledTimes(1);
    expect(res.headers.get("location")).toBe("/waitlist/news?verified=1&rt=REF&t=ten_A");
  });

  it("with the switch off, confirms a site sign-up on the click too", async () => {
    seed("site");
    await get();
    expect(verifySignupByToken).toHaveBeenCalledTimes(1);
  });
});
