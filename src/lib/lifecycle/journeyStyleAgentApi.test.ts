import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { signCanvasContext } from "@/lib/canvas/auth";
import { TENANT_ID, publishOnboarding, seedWorld, setJourneyStyle } from "./testing/fixtures";
import { CAMPAIGN_ID, publishWaitlist, seedLaunch } from "./waitlist/testing/fixtures";
import { agentJourneyStyle, journeyStyleAgentGate } from "./journeyStyleAgentApi";

const admin: TenantContext = { tenantId: TENANT_ID, region: "eu", source: "agent", userId: "usr_1", role: "admin" };
const member: TenantContext = { ...admin, userId: "usr_2", role: "member" };
const BRAND_STYLE = { logo: null, companyName: "Sandbox Co", headerColor: "#0b1f3a", accentColor: "#ff6b35" };
const NAVY = { headerColor: "#000080", accentColor: "#f59e0b" };
const req = (token?: string) =>
  new Request("https://app.example.com/api/agent/journey-style?journeyId=lcj_x", {
    headers: token ? { "x-canvas-context": token } : {},
  });

beforeEach(() => {
  vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
  vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
  vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-only-canvas-key");
});
afterEach(() => vi.unstubAllEnvs());

async function productWorld() {
  const db = new FakeFirestore();
  seedWorld(db);
  db.seed("tenants", TENANT_ID, {
    ...db.raw("tenants", TENANT_ID),
    emailStyle: BRAND_STYLE,
    brandKit: { palette: [{ hex: "#0B1F3A", name: "Navy", role: "primary" }] },
  });
  const { journey } = await publishOnboarding(db);
  return { db, journey };
}

describe("journeyStyleAgentGate", () => {
  it("503s while either flag is off, then checks the token", () => {
    for (const [flag, value] of [
      ["EMAIL_STYLE_ENABLED", "false"],
      ["EMAIL_JOURNEY_STYLE_ENABLED", "false"],
    ] as const) {
      vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
      vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
      vi.stubEnv(flag, value);
      expect(journeyStyleAgentGate(req(signCanvasContext(admin)))).toEqual({
        ok: false,
        result: { status: 503, body: { error: "unavailable" } },
      });
    }
    vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    expect(journeyStyleAgentGate(req())).toMatchObject({ ok: false, result: { status: 401 } });
    expect(journeyStyleAgentGate(req("forged.token"))).toMatchObject({ ok: false, result: { status: 401 } });
    expect(journeyStyleAgentGate(req(signCanvasContext(admin)))).toMatchObject({ ok: true, ctx: { tenantId: TENANT_ID, role: "admin" } });
  });
});

describe("agentJourneyStyle", () => {
  it("reads a product journey: the brand's style, the draft's and the live one, with no people", async () => {
    const { db, journey } = await productWorld();
    await setJourneyStyle(db, journey.id, NAVY, { publish: false });
    const r = await agentJourneyStyle(admin, { journeyId: journey.id }, db);
    expect(r).toEqual({
      status: 200,
      body: {
        journey: {
          id: journey.id,
          name: "Onboarding",
          kind: "product",
          status: "active",
          publishedVersion: 1,
          url: `/admin/lifecycle/${journey.id}`,
        },
        canEdit: true,
        brand: {
          url: "/admin/brand-kit/email-style",
          headerColor: "#0b1f3a",
          buttonColor: "#ff6b35",
          logo: false,
          name: "Sandbox Co",
          headerImage: false,
        },
        palette: [{ hex: "#0b1f3a", name: "Navy" }],
        draft: { mode: "custom", headerColor: "#000080", buttonColor: "#f59e0b" },
        live: { mode: "brand" },
        changedSincePublish: true,
        note: expect.stringContaining("Vizzy sets the draft only"),
      },
    });
    // Nobody's address, test recipient or shadow inbox.
    expect(JSON.stringify(r.body)).not.toContain("@");
  });

  it("with header options on, spells out the gradient and header text", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const { db, journey } = await productWorld();
    await setJourneyStyle(db, journey.id, { ...NAVY, headerGradientColor: "#4f46e5" });
    const body = (await agentJourneyStyle(member, { journeyId: journey.id }, db)).body as Record<string, unknown>;
    expect(body).toMatchObject({
      canEdit: false,
      headerOptions: true,
      brand: { headerGradientColor: null, headerText: "auto" },
      draft: { mode: "custom", headerColor: "#000080", buttonColor: "#f59e0b", headerGradientColor: "#4f46e5", headerText: "auto" },
      live: { mode: "custom", headerGradientColor: "#4f46e5" },
      changedSincePublish: false,
      note: expect.stringContaining("headerGradientColor fades the header"),
    });
  });

  it("finds a launch's welcome journey by its campaignId, and says when it isn't on the new engine", async () => {
    const db = new FakeFirestore();
    seedLaunch(db);
    const missing = await agentJourneyStyle(admin, { campaignId: CAMPAIGN_ID }, db);
    expect(missing).toMatchObject({ status: 404, body: { error: "journey_not_found", issues: [expect.stringContaining("haven't moved")] } });
    const { journey } = await publishWaitlist(db);
    const r = await agentJourneyStyle(admin, { campaignId: CAMPAIGN_ID }, db);
    expect(r).toMatchObject({
      status: 200,
      body: {
        journey: { id: journey.id, kind: "launch_welcome", launch: { id: CAMPAIGN_ID, name: "Fernlight" } },
        brand: null,
        draft: { mode: "brand" },
        live: { mode: "brand" },
        note: expect.stringContaining("still send from the original engine"),
      },
    });
    expect(JSON.stringify(r.body)).not.toContain("@");
    db.seed("campaigns", CAMPAIGN_ID, { ...db.raw("campaigns", CAMPAIGN_ID), waitlistEngine: "lifecycle" });
    const moved = (await agentJourneyStyle(admin, { journeyId: journey.id }, db)).body as { note: string };
    expect(moved.note).not.toContain("original engine");
  });

  it("400s both ids, neither, or an id that isn't one; 404s another tenant's journey", async () => {
    const { db, journey } = await productWorld();
    for (const q of [{}, { journeyId: journey.id, campaignId: CAMPAIGN_ID }, { journeyId: "a/b" }]) {
      expect(await agentJourneyStyle(admin, q, db)).toMatchObject({ status: 400, body: { error: "invalid_input" } });
    }
    db.seed("lifecycle_journeys", "lcj_foreign", { ...db.raw("lifecycle_journeys", journey.id), tenantId: "ten_other" });
    expect(await agentJourneyStyle(admin, { journeyId: "lcj_foreign" }, db)).toEqual({ status: 404, body: { error: "journey_not_found" } });
  });
});
