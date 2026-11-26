import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

const { db, computeRanks } = vi.hoisted(() => ({
  db: { current: null as unknown },
  computeRanks: vi.fn(async () => new Map([["su1", 3]])),
}));
vi.mock("@/lib/tenant", async (orig) => {
  const actual = await orig<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    resolveTenantForRequest: async () => ({ tenantId: "ten_A", region: "us", source: "tenant_param" }),
    forTenant: (ctx: Parameters<typeof actual.forTenant>[0]) => actual.forTenant(ctx, db.current as never),
  };
});
vi.mock("@/lib/waitlist/rank", () => ({ computeRanks }));

import { POST } from "./route";

let fake: FakeFirestore;

function seed(signup: Record<string, unknown> = {}) {
  fake = new FakeFirestore();
  fake.seed("campaigns", "beta", {
    tenantId: "ten_A",
    waitlistName: "Acme beta",
    aiConversation: { enabled: true, leaderboardBonus: 5 },
    createdAt: "2026-10-01T00:00:00Z",
  });
  fake.seed("signups", "su1", {
    tenantId: "ten_A",
    campaignId: "beta",
    email: "sam@example.com",
    status: "verified_active",
    referralToken: "REF1",
    createdAt: "2026-10-22T09:00:00Z",
    ...signup,
  });
  db.current = fake;
}

const complete = (transcript: Array<{ role: "user" | "model"; text: string }>) =>
  POST(
    new Request("https://yougrow.test/api/waitlist/beta/conversation/complete?t=ten_A", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referralToken: "REF1", transcript }),
    }),
    { params: Promise.resolve({ campaignId: "beta" }) },
  );

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("finishing a waitlist voice chat (POST conversation/complete)", () => {
  it("refuses a chat in which the person said nothing, and writes nothing", async () => {
    seed();
    for (const transcript of [[], [{ role: "model" as const, text: "Hi! What brought you here?" }], [{ role: "user" as const, text: "   " }]]) {
      const res = await complete(transcript);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "empty_conversation" });
    }
    expect(fake.writeCountFor("signups", "su1")).toBe(0);
    expect(fake.raw("signups", "su1")?.aiConversation).toBeUndefined();
    expect(fake.raw("signups", "su1")?.engagementBonus).toBeUndefined();
    expect(computeRanks).not.toHaveBeenCalled();
  });

  it("lets the sign-up try again after an empty one, and credits a real chat once", async () => {
    seed();
    expect((await complete([])).status).toBe(400);

    const transcript = [
      { role: "model" as const, text: "Hi! What brought you here?" },
      { role: "user" as const, text: "I want faster invoicing." },
    ];
    const res = await complete(transcript);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bonus: 5, rank: 3 });
    const saved = fake.raw("signups", "su1")!;
    expect(saved.engagementBonus).toBe(5);
    expect(saved.aiConversation).toMatchObject({ completed: true, transcript, bonusApplied: true });

    // Sent again (a retry, a second tab): no new write, no second bonus.
    const again = await complete(transcript);
    expect(await again.json()).toEqual({ ok: true, already: true });
    expect(fake.writeCountFor("signups", "su1")).toBe(1);
  });

  it("answers a completed chat as already done, even with an empty transcript", async () => {
    seed({ aiConversation: { completed: true, transcript: [], capturedAt: "2026-10-23T09:00:00Z", bonusApplied: true }, engagementBonus: 5 });
    const res = await complete([]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, already: true });
    expect(fake.writeCountFor("signups", "su1")).toBe(0);
  });
});
