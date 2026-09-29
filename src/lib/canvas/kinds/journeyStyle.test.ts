import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { saveLifecycleDraft } from "@/lib/lifecycle/service";
import { TENANT_ID, ctx as human, publishOnboarding, seedWorld, setJourneyStyle } from "@/lib/lifecycle/testing/fixtures";
import { CAMPAIGN_ID, publishWaitlist, seedLaunch } from "@/lib/lifecycle/waitlist/testing/fixtures";
import { waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";
import { asCard } from "@/components/admin/chat/cardData";
import { isJourneyDraftCard } from "@/components/admin/lifecycle/journeyStyleForm";
import { getCanvasKind } from "../registry";
import { authorJourneyStyle } from "./journeyStyle";

const admin: TenantContext = { tenantId: TENANT_ID, region: "eu", source: "agent", userId: "usr_1", role: "admin" };
const member: TenantContext = { ...admin, userId: "usr_2", role: "member" };
const BRAND_STYLE = { logo: null, companyName: "Sandbox Co", headerColor: "#0b1f3a", accentColor: "#ff6b35" };
const NAVY = { headerColor: "#000080", accentColor: "#f59e0b" };

beforeEach(() => {
  vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
  vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
  vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
  __resetRateLimitState();
});
afterEach(() => vi.unstubAllEnvs());

/** A published product journey, on a brand with an Email style saved. */
async function productWorld() {
  const db = new FakeFirestore();
  seedWorld(db);
  db.seed("tenants", TENANT_ID, { ...db.raw("tenants", TENANT_ID), emailStyle: BRAND_STYLE });
  const { journey } = await publishOnboarding(db);
  return { db, journey };
}

type Doc = { draft: { settings: Record<string, unknown> } & Record<string, unknown>; emailStyle?: unknown } & Record<string, unknown>;
const raw = (db: FakeFirestore, id: string) => structuredClone(db.raw("lifecycle_journeys", id)) as Doc;

const author = (db: FakeFirestore, input: Record<string, unknown>, ctx: TenantContext = admin) =>
  authorJourneyStyle({ ctx, input: { kind: "journey_style", action: "save_draft", brief: "navy header", ...input }, brief: "navy header" }, { db });

describe("journey_style canvas kind: who and when", () => {
  it("is registered", () => {
    expect(getCanvasKind("journey_style")?.label).toBe("journey email style");
  });

  it("503s while either flag is off, even for garbage, and writes nothing", async () => {
    const { db, journey } = await productWorld();
    const before = raw(db, journey.id);
    for (const [flag, value] of [
      ["EMAIL_JOURNEY_STYLE_ENABLED", "false"],
      ["EMAIL_STYLE_ENABLED", "false"],
    ] as const) {
      vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
      vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
      vi.stubEnv(flag, value);
      for (const input of [{ journeyId: journey.id, mode: "custom", headerColor: "#000080" }, { nonsense: [1, 2] }, {}]) {
        expect(await author(db, input)).toEqual({ ok: false, status: 503, error: "unavailable" });
      }
    }
    expect(raw(db, journey.id)).toEqual(before);
  });

  it("is admin only (a token without a role too)", async () => {
    const { db, journey } = await productWorld();
    const input = { journeyId: journey.id, mode: "custom", headerColor: "#000080" };
    expect(await author(db, input, member)).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await author(db, input, { ...admin, role: undefined })).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(raw(db, journey.id).draft.settings).not.toHaveProperty("emailStyle");
  });

  it("400s a colour that isn't one, an unknown key and a brand mode with colours", async () => {
    const { db, journey } = await productWorld();
    for (const input of [
      { journeyId: journey.id, mode: "custom", headerColor: "navy" },
      { journeyId: journey.id, mode: "custom", buttonColor: "#12345" },
      { journeyId: journey.id, mode: "custom", headerText: "grey" },
      { journeyId: journey.id, mode: "custom", logo: "primary" },
      { journeyId: journey.id, mode: "sparkly" },
      { journeyId: journey.id, mode: "brand", headerColor: "#000080" },
      { journeyId: "lcj_a/b", mode: "brand" },
    ]) {
      const r = await author(db, input);
      expect(r, JSON.stringify(input)).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
    }
    expect(raw(db, journey.id).draft.settings).not.toHaveProperty("emailStyle");
  });

  it("400s both ids or neither", async () => {
    const { db, journey } = await productWorld();
    for (const input of [{ mode: "brand" }, { journeyId: journey.id, campaignId: CAMPAIGN_ID, mode: "brand" }]) {
      expect(await author(db, input)).toEqual({
        ok: false,
        status: 400,
        error: "invalid_input",
        issues: ["journeyId/campaignId: give exactly one"],
      });
    }
  });

  it("404s an archived journey, another tenant's and one that isn't there", async () => {
    const { db, journey } = await productWorld();
    db.seed("lifecycle_journeys", "lcj_foreign", { ...raw(db, journey.id), tenantId: "ten_other" });
    expect(await author(db, { journeyId: "lcj_foreign", mode: "custom", headerColor: "#000080" })).toMatchObject({
      ok: false,
      status: 404,
      error: "journey_not_found",
    });
    expect(raw(db, "lcj_foreign").draft.settings).not.toHaveProperty("emailStyle");
    expect(await author(db, { journeyId: "lcj_missing", mode: "brand" })).toMatchObject({ status: 404, error: "journey_not_found" });
    db.seed("lifecycle_journeys", journey.id, { ...raw(db, journey.id), status: "archived" });
    expect(await author(db, { journeyId: journey.id, mode: "custom", headerColor: "#000080" })).toMatchObject({
      status: 404,
      error: "journey_not_found",
    });
    expect(raw(db, journey.id).draft.settings).not.toHaveProperty("emailStyle");
  });

  it("is rate-limited per tenant: the 6th in a burst gets 429", async () => {
    const { db, journey } = await productWorld();
    for (let i = 0; i < 5; i++) expect((await author(db, { journeyId: journey.id, mode: "brand" })).ok).toBe(true);
    expect(await author(db, { journeyId: journey.id, mode: "brand" })).toEqual({ ok: false, status: 429, error: "rate_limited" });
  });
});

describe("journey_style canvas kind: what it writes", () => {
  it("sets only the draft's style: the rest of the draft, the live style and the version are untouched", async () => {
    const { db, journey } = await productWorld();
    const before = raw(db, journey.id);
    const r = await author(db, { journeyId: journey.id, mode: "custom", headerColor: "#000080", buttonColor: "#F59E0B" });
    if (!r.ok) throw new Error(r.error);
    const after = raw(db, journey.id);
    expect(after.draft).toEqual({ ...before.draft, settings: { ...before.draft.settings, emailStyle: NAVY } });
    expect(after.emailStyle).toEqual(before.emailStyle);
    expect(after.publishedVersion).toBe(1);
    const { draft: _d, updatedAt: _u, authoredBy, ...rest } = after;
    const { draft: _bd, updatedAt: _bu, authoredBy: _ba, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(authoredBy).toBe("agent");
    expect(db.raw("lifecycle_versions", `${journey.id}_v1`)).not.toHaveProperty("settings.emailStyle");
  });

  it("answers with the journey's id and url, so the editor in view reloads", async () => {
    const { db, journey } = await productWorld();
    const r = await author(db, { journeyId: journey.id, mode: "custom", headerColor: "#000080" });
    expect(r).toEqual({
      ok: true,
      id: journey.id,
      status: "active",
      url: `/admin/lifecycle/${journey.id}`,
      summary:
        'I set "Onboarding" to its own email style in its draft: header #000080, button #ff6b35, with your logo, name and ' +
        "theme. Its emails keep their current look until you publish the journey; then every email it sends from then on wears it.",
      warnings: [],
      card: {
        kind: "journey_style",
        id: journey.id,
        title: "Onboarding",
        subtitle: "Email style",
        url: `/admin/lifecycle/${journey.id}`,
        stats: [
          { label: "header", value: "#000080" },
          { label: "button", value: "#ff6b35" },
        ],
        warnings: 0,
        note: "Saved to the draft — publish the journey to apply it.",
        cta: "Open journey",
      },
    });
  });

  it("its card, as the chat reads it, reloads that journey's editor and no other", async () => {
    const { db, journey } = await productWorld();
    const r = await author(db, { journeyId: journey.id, mode: "custom", headerColor: "#000080" });
    if (!r.ok) throw new Error(r.error);
    // What the canvas endpoint returns and the agent's tool result carries.
    const card = asCard({ card: r.card });
    expect(card).toMatchObject({ kind: "journey_style", id: journey.id, url: `/admin/lifecycle/${journey.id}` });
    expect(isJourneyDraftCard(card!, journey.id)).toBe(true);
    expect(isJourneyDraftCard(card!, "lcj_other")).toBe(false);
  });

  it("custom starts from the draft's own colours, else the brand's; brand clears it", async () => {
    const { db, journey } = await productWorld();
    // Nothing stored: the brand's button colour stays.
    await author(db, { journeyId: journey.id, mode: "custom", headerColor: "#000080" });
    expect(raw(db, journey.id).draft.settings.emailStyle).toEqual({ headerColor: "#000080", accentColor: "#ff6b35" });
    // Stored: its header colour stays.
    await author(db, { journeyId: journey.id, mode: "custom", buttonColor: "rgb(245, 158, 11)" });
    expect(raw(db, journey.id).draft.settings.emailStyle).toEqual(NAVY);
    const r = await author(db, { journeyId: journey.id, mode: "brand" });
    expect(raw(db, journey.id).draft.settings).not.toHaveProperty("emailStyle");
    expect(r).toMatchObject({
      ok: true,
      summary:
        'I set "Onboarding" back to your brand\'s Email style in its draft. Its emails keep their current look until you ' +
        "publish the journey; then every email it sends from then on wears it.",
      card: { stats: [{ label: "style", value: "brand's Email style" }] },
    });
  });

  it("with no brand style saved, custom starts from near-black; an unpublished journey applies on its first publish", async () => {
    const db = new FakeFirestore();
    seedLaunch(db);
    const created = await publishWaitlist(db);
    db.seed("lifecycle_journeys", created.journey.id, { ...raw(db, created.journey.id), publishedVersion: null });
    const r = await author(db, { journeyId: created.journey.id, mode: "custom", buttonColor: "#f59e0b" });
    expect(raw(db, created.journey.id).draft.settings.emailStyle).toEqual({ headerColor: "#111111", accentColor: "#f59e0b" });
    expect(r).toMatchObject({ ok: true, summary: expect.stringContaining("It applies once the journey is published.") });
  });

  it("a campaignId sets that launch's welcome journey", async () => {
    const db = new FakeFirestore();
    seedLaunch(db, { waitlistEngine: "lifecycle" });
    const { journey } = await publishWaitlist(db);
    expect(journey.id).toBe(waitlistJourneyId(CAMPAIGN_ID));
    const r = await author(db, { campaignId: CAMPAIGN_ID, mode: "custom", headerColor: "#000080", buttonColor: "#f59e0b" });
    expect(r).toMatchObject({ ok: true, id: journey.id, url: `/admin/lifecycle/${journey.id}`, warnings: [], card: { id: journey.id } });
    expect(raw(db, journey.id).draft.settings.emailStyle).toEqual(NAVY);
    // Live stays the brand's (publish wrote null) until an admin publishes again.
    expect(raw(db, journey.id).emailStyle).toBeNull();
  });

  it("a launch whose welcome emails haven't moved is a 404 that says so; one still on the original engine warns", async () => {
    const db = new FakeFirestore();
    seedLaunch(db);
    expect(await author(db, { campaignId: "nope", mode: "brand" })).toMatchObject({ status: 404, error: "launch_not_found" });
    expect(await author(db, { campaignId: CAMPAIGN_ID, mode: "brand" })).toMatchObject({
      status: 404,
      error: "journey_not_found",
      issues: [expect.stringContaining("haven't moved to the new journey engine")],
    });
    await publishWaitlist(db);
    const r = await author(db, { campaignId: CAMPAIGN_ID, mode: "custom", headerColor: "#000080" });
    expect(r).toMatchObject({ ok: true, warnings: [expect.stringContaining("still send from the original engine")], card: { warnings: 1 } });
  });

  it("an editor save of a draft loaded before it keeps the style it set", async () => {
    const { db, journey } = await productWorld();
    const stale = structuredClone(journey.draft);
    await author(db, { journeyId: journey.id, mode: "custom", headerColor: "#000080", buttonColor: "#f59e0b" });
    stale.pools[0]!.items[0]!.subject = "Edited after";
    const saved = await saveLifecycleDraft(human, journey.id, stale, { db, authoredBy: "human", emailStyle: "from_input" });
    expect(saved.ok).toBe(true);
    expect(raw(db, journey.id).draft.settings.emailStyle).toEqual(NAVY);
  });

  it("header options off: a real gradient or text is refused, the defaults ignored, and a stored one kept", async () => {
    const { db, journey } = await productWorld();
    for (const input of [{ headerGradientColor: "#ff0000" }, { headerText: "white" }]) {
      expect(await author(db, { journeyId: journey.id, mode: "custom", ...input })).toMatchObject({
        ok: false,
        status: 400,
        error: "header_options_unavailable",
      });
    }
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    await setJourneyStyle(db, journey.id, { ...NAVY, headerGradientColor: "#ff0000", headerText: "white" }, { publish: false });
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
    const r = await author(db, { journeyId: journey.id, mode: "custom", headerColor: "#0f766e", headerGradientColor: null, headerText: "auto" });
    expect(raw(db, journey.id).draft.settings.emailStyle).toEqual({
      headerColor: "#0f766e",
      accentColor: "#f59e0b",
      headerGradientColor: "#ff0000",
      headerText: "white",
    });
    // Neither draws, so neither is claimed.
    expect(r).toMatchObject({ ok: true, card: { stats: [{ label: "header", value: "#0f766e" }, { label: "button", value: "#f59e0b" }] } });
  });

  it("header options on: a gradient and header text, null for solid, auto, and a colour 2 equal to the header dropped", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const { db, journey } = await productWorld();
    const r = await author(db, {
      journeyId: journey.id,
      mode: "custom",
      headerColor: "#000080",
      headerGradientColor: "#4f46e5",
      headerText: "white",
    });
    expect(raw(db, journey.id).draft.settings.emailStyle).toEqual({
      headerColor: "#000080",
      accentColor: "#ff6b35",
      headerGradientColor: "#4f46e5",
      headerText: "white",
    });
    expect(r).toMatchObject({
      ok: true,
      summary: expect.stringContaining("header #000080 fading to #4f46e5, white header text, button #ff6b35"),
      card: {
        stats: [
          { label: "header", value: "#000080 → #4f46e5" },
          { label: "text", value: "white" },
          { label: "button", value: "#ff6b35" },
        ],
      },
    });
    await author(db, { journeyId: journey.id, mode: "custom", headerGradientColor: null, headerText: "auto" });
    expect(raw(db, journey.id).draft.settings.emailStyle).toEqual({ headerColor: "#000080", accentColor: "#ff6b35" });
    await author(db, { journeyId: journey.id, mode: "custom", headerGradientColor: "#000080" });
    expect(raw(db, journey.id).draft.settings.emailStyle).toEqual({ headerColor: "#000080", accentColor: "#ff6b35" });
  });

  it("says a brand banner isn't used on a Custom journey", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    vi.stubEnv("EMAIL_LINK_ORIGIN", "https://app.example.com");
    const { db, journey } = await productWorld();
    db.seed("tenants", TENANT_ID, {
      ...db.raw("tenants", TENANT_ID),
      emailStyle: { ...BRAND_STYLE, headerImage: { id: "hdr_1", filename: "0f8fad5b-d9cb-469f-a165-70867728950e.png", width: 1200, height: 300 } },
    });
    const r = await author(db, { journeyId: journey.id, mode: "custom", headerColor: "#000080" });
    expect(r).toMatchObject({
      ok: true,
      summary: expect.stringContaining("Your header image isn't used here: this journey's emails show your name on the header colour."),
    });
  });
});
