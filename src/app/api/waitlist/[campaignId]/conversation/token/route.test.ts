import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateAuthTokenParameters } from "@google/genai";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

const { db, create, live } = vi.hoisted(() => {
  const create = vi.fn(async (_params: unknown) => ({ name: "auth_tokens/abc" }));
  return { db: { current: null as unknown }, create, live: { current: { authTokens: { create } } as unknown } };
});
vi.mock("@/lib/tenant", async (orig) => {
  const actual = await orig<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    resolveTenantForRequest: async () => ({ tenantId: "ten_A", region: "us", source: "tenant_param" }),
    forTenant: (ctx: Parameters<typeof actual.forTenant>[0]) => actual.forTenant(ctx, db.current as never),
  };
});
vi.mock("@/lib/agents/gemini", () => ({ getLiveTokenClient: () => live.current }));
vi.mock("@/lib/content/create/activeBrandVoice", () => ({ activeBrandVoiceText: async () => null }));

import { POST } from "./route";
import { LIVE_MODEL } from "@/lib/agents/liveConversation";

function seed(signup: Record<string, unknown> = {}) {
  const fake = new FakeFirestore();
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

const token = () =>
  POST(
    new Request("https://yougrow.test/api/waitlist/beta/conversation/token?t=ten_A", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referralToken: "REF1" }),
    }),
    { params: Promise.resolve({ campaignId: "beta" }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  live.current = { authTokens: { create } };
});

describe("starting a waitlist voice chat (POST conversation/token)", () => {
  it("mints a single-use token that locks the model and the config, with no session resumption", async () => {
    seed();
    const res = await token();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "auth_tokens/abc", model: LIVE_MODEL });
    const { config } = create.mock.calls[0]![0] as CreateAuthTokenParameters;
    expect(config?.uses).toBe(1);
    expect(config?.httpOptions).toEqual({ apiVersion: "v1alpha" });
    expect(config?.liveConnectConstraints?.model).toBe(LIVE_MODEL);
    const locked = config?.liveConnectConstraints?.config;
    expect(locked?.responseModalities).toEqual(["AUDIO"]);
    expect(locked?.systemInstruction).toEqual(expect.stringContaining("Acme beta"));
    expect(locked).not.toHaveProperty("sessionResumption");
    expect(locked).not.toHaveProperty("speechConfig");
  });

  it("says the chat is already done for a sign-up that finished one", async () => {
    seed({
      aiConversation: {
        completed: true,
        transcript: [{ role: "model", text: "Hi! What brought you here?" }, { role: "user", text: "Faster invoicing." }],
        capturedAt: "2026-10-23T09:00:00Z",
        bonusApplied: true,
      },
    });
    const res = await token();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_completed" });
    expect(create).not.toHaveBeenCalled();
  });

  it("starts a new chat for a sign-up whose saved chat had no words from them", async () => {
    // Saved by the old browser code when the call dropped.
    seed({ aiConversation: { completed: true, transcript: [], capturedAt: "2026-10-23T09:00:00Z", bonusApplied: true }, engagementBonus: 5 });
    const res = await token();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "auth_tokens/abc", model: LIVE_MODEL });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("says voice is unavailable when no Live key is set, or Google gives no token", async () => {
    seed();
    live.current = null;
    expect((await token()).status).toBe(503);
    live.current = { authTokens: { create } };
    create.mockRejectedValueOnce(new Error("refused"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await token();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});
