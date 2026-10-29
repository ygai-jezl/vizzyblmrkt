import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { signCanvasContext } from "@/lib/canvas/auth";
import { T0, TENANT_ID, ctx, seedUser, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import { agentAudienceCounts, audienceAgentGate } from "./agentCounts";
import { syncPerson } from "./personSync";

const req = (token?: string) => new Request("https://app.example.com/api/agent/audience/counts", { headers: token ? { "x-canvas-context": token } : {} });

beforeEach(() => {
  __resetRateLimitState();
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-only-canvas-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("Vizzy's audience counts", () => {
  it("needs the one view and a valid canvas token, and takes the brand from the token", () => {
    const agent = { ...ctx, source: "agent" as const, userId: "u1", role: "admin" as const };
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "false");
    expect(audienceAgentGate(req(signCanvasContext(agent)))).toMatchObject({ ok: false, result: { status: 503 } });
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
    expect(audienceAgentGate(req())).toMatchObject({ ok: false, result: { status: 401 } });
    expect(audienceAgentGate(req("forged.token"))).toMatchObject({ ok: false, result: { status: 401 } });
    expect(audienceAgentGate(req(signCanvasContext(agent)))).toMatchObject({ ok: true, ctx: { tenantId: TENANT_ID } });
  });

  it("gives counts only, never a person", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedUser(db, "ada", { firstName: "Ada" });
    seedUser(db, "bea");
    for (const k of ["ada@customer.test", "bea@customer.test"]) await syncPerson(ctx, k, { db, nowMs: T0 });
    const r = await agentAudienceCounts(ctx, db);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ people: 2, canEmail: 2, fromYourSite: 0, launches: [], products: [{ name: "Sandbox", people: 2, stages: { new: 2 } }] });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("@");
    expect(text).not.toContain("Ada");
    expect(text).not.toContain("pu_");
  });
});
