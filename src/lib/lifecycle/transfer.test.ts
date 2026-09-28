import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { LifecycleSettingsSchema } from "@/lib/types/lifecycle";
import { publishLifecycleJourney, saveLifecycleDraft } from "./service";
import { duplicateJourney, exportJourneyDocument, importJourneyDocument, JOURNEY_DOCUMENT_FORMAT } from "./transfer";
import { CONNECTION_ID, ctx, publishOnboarding, seedWorld } from "./testing/fixtures";

const T = Date.parse("2026-09-22T12:00:00Z");

beforeEach(() => {
  process.env.LIFECYCLE_MODE_CEILING = "live";
});
afterEach(() => {
  delete process.env.LIFECYCLE_MODE_CEILING;
  vi.unstubAllEnvs();
});

/** A second product in the same account (e.g. the customer's production app). */
function seedSecondConnection(db: FakeFirestore, id = "pcn_prod") {
  const base = db.raw("product_connections", CONNECTION_ID) as Record<string, unknown>;
  db.seed("product_connections", id, { ...base, name: "Acme (production)", keyId: "ygk_prod" });
  return id;
}

async function world() {
  const db = new FakeFirestore();
  seedWorld(db);
  const { journey } = await publishOnboarding(db, { mode: "test", testUserIds: ["alex"] });
  return { db, journey };
}

describe("journey transfer", () => {
  it("exports the published design only — no account, connection or people", async () => {
    const { db, journey } = await world();
    const r = await exportJourneyDocument(ctx, journey.id, { db, nowMs: T });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ format: JOURNEY_DOCUMENT_FORMAT, formatVersion: 1, name: "Onboarding", sourceVersion: 1 });
    const text = JSON.stringify(r.value);
    for (const leak of ["tenantId", CONNECTION_ID, "testRecipients", "alex", "shadowInbox", "ygk_"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("exports the draft on request, and the draft when never published", async () => {
    const { db, journey } = await world();
    const edited = { ...journey.draft, settings: { ...journey.draft.settings, category: { key: "tips", label: "Tips" } } };
    await saveLifecycleDraft(ctx, journey.id, edited, { db });
    const pub = await exportJourneyDocument(ctx, journey.id, { db });
    const drf = await exportJourneyDocument(ctx, journey.id, { which: "draft", db });
    expect(pub.ok && pub.value.draft.settings.category.key).toBe("onboarding");
    expect(drf.ok && drf.value).toMatchObject({ sourceVersion: null, draft: { settings: { category: { key: "tips" } } } });
  });

  it("duplicates onto another product as a fresh draft in test mode", async () => {
    const { db, journey } = await world();
    const prod = seedSecondConnection(db);
    const r = await duplicateJourney(ctx, journey.id, { connectionId: prod }, { db, nowMs: T });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const copy = (await forTenant(ctx, db).lifecycleJourneys.getById(r.value.journeyId))!;
    expect(copy).toMatchObject({
      name: "Onboarding (copy)",
      connectionId: prod,
      status: "draft",
      deliveryMode: "test",
      publishedVersion: null,
      testRecipients: { userIds: [], emails: [] },
    });
    expect(copy.draft.graph).toEqual(journey.draft.graph);
    expect(r.value.issues).toEqual([]);
  });

  it("imports a downloaded document into the account, and refuses anything else", async () => {
    const { db, journey } = await world();
    const exported = await exportJourneyDocument(ctx, journey.id, { db });
    if (!exported.ok) throw new Error("export failed");
    const doc = JSON.parse(JSON.stringify(exported.value));

    const ok = await importJourneyDocument(ctx, { connectionId: CONNECTION_ID, name: "Imported", document: doc }, { db });
    expect(ok.ok).toBe(true);

    const bad = await importJourneyDocument(ctx, { connectionId: CONNECTION_ID, document: { ...doc, format: "something" } }, { db });
    expect(bad).toMatchObject({ ok: false, status: 400, error: "invalid_document" });
    const huge = await importJourneyDocument(ctx, { connectionId: CONNECTION_ID, document: { ...doc, pad: "x".repeat(600_000) } }, { db });
    expect(huge).toMatchObject({ ok: false, status: 413 });
    const noConn = await importJourneyDocument(ctx, { connectionId: "pcn_nope", document: doc }, { db });
    expect(noConn).toMatchObject({ ok: false, status: 404, error: "connection_not_found" });
  });

  // Pinned: a journey style is coming to a draft's settings behind a flag. A journey without one
  // must keep exporting exactly this, and new settings carry no such key.
  it("pins today's export document and the default settings", async () => {
    const { db, journey } = await world();
    const r = await exportJourneyDocument(ctx, journey.id, { db, nowMs: T });
    if (!r.ok) throw new Error("export failed");
    const { draft, ...head } = r.value;
    expect(head).toEqual({
      format: JOURNEY_DOCUMENT_FORMAT,
      formatVersion: 1,
      exportedAt: "2026-09-22T12:00:00.000Z",
      name: "Onboarding",
      sourceVersion: 1,
    });
    expect(Object.keys(draft)).toEqual(["graph", "pools", "settings"]);
    const v1 = (await forTenant(ctx, db).lifecycleVersions.getById(`${journey.id}_v1`))!;
    expect(draft.graph).toEqual(v1.graph);
    expect(draft.pools).toEqual(v1.pools);
    expect(draft.settings).toMatchInlineSnapshot(`
      {
        "about": {
          "fact": null,
          "includeJoined": false,
          "kind": null,
          "maxListed": 5,
          "mode": "person",
          "pick": "focus",
        },
        "category": {
          "key": "onboarding",
          "label": "Onboarding tips",
        },
        "entry": {
          "requireMarketingConsent": false,
        },
        "sendPolicy": {
          "days": [
            1,
            2,
            3,
            4,
            5,
          ],
          "fallbackTimezone": "Europe/London",
          "hardStopDays": 12,
          "startHour": 9,
          "startMinute": 0,
          "windowMinutes": 90,
        },
        "sender": {},
        "tracking": {
          "clicks": false,
          "opens": false,
        },
        "trigger": {
          "event": "user.signed_up",
          "maxEventAgeHours": 72,
        },
      }
    `);

    const defaults = LifecycleSettingsSchema.parse({});
    expect(defaults).not.toHaveProperty("emailStyle");
    expect(defaults).toMatchInlineSnapshot(`
      {
        "about": {
          "fact": null,
          "includeJoined": false,
          "kind": null,
          "maxListed": 5,
          "mode": "person",
          "pick": "focus",
        },
        "category": {
          "key": "onboarding",
          "label": "Onboarding tips",
        },
        "entry": {
          "requireMarketingConsent": false,
        },
        "sendPolicy": {
          "days": [
            1,
            2,
            3,
            4,
            5,
          ],
          "fallbackTimezone": "Europe/London",
          "hardStopDays": 12,
          "startHour": 9,
          "startMinute": 0,
          "windowMinutes": 90,
        },
        "sender": {},
        "tracking": {
          "clicks": false,
          "opens": false,
        },
        "trigger": {
          "event": "user.signed_up",
          "maxEventAgeHours": 72,
        },
      }
    `);
  });

  describe("a journey's own email style", () => {
    const NAVY = { headerColor: "#0b1f3a", accentColor: "#ff6b35" };
    const TEAL = { headerColor: "#0f766e", accentColor: "#f59e0b", headerText: "white" };
    type Raw = { draft: { settings: Record<string, unknown> } };
    function storeStyle(db: FakeFirestore, id: string, style: unknown) {
      const doc = structuredClone(db.raw("lifecycle_journeys", id)) as Raw;
      doc.draft.settings.emailStyle = style;
      db.seed("lifecycle_journeys", id, doc);
    }

    it("duplicate keeps it, with the flag on and with it off", async () => {
      for (const flag of ["true", "false"]) {
        vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", flag);
        const { db, journey } = await world();
        const prod = seedSecondConnection(db);
        storeStyle(db, journey.id, TEAL);
        const r = await duplicateJourney(ctx, journey.id, { connectionId: prod, which: "draft" }, { db, nowMs: T });
        if (!r.ok) throw new Error(r.error);
        expect((db.raw("lifecycle_journeys", r.value.journeyId) as Raw).draft.settings.emailStyle).toEqual(TEAL);
      }
    });

    it("a published export carries the live style, not the draft's", async () => {
      vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
      const { db, journey } = await world();
      storeStyle(db, journey.id, NAVY);
      await publishLifecycleJourney(ctx, journey.id, { db, nowMs: T });
      storeStyle(db, journey.id, TEAL);
      const pub = await exportJourneyDocument(ctx, journey.id, { db });
      const drf = await exportJourneyDocument(ctx, journey.id, { which: "draft", db });
      expect(pub.ok && pub.value.draft.settings.emailStyle).toEqual(NAVY);
      expect(drf.ok && drf.value.draft.settings.emailStyle).toEqual(TEAL);

      // Published with the flag off, the live style stays what it was (the version keeps none).
      vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "false");
      await publishLifecycleJourney(ctx, journey.id, { db, nowMs: T });
      const killed = await exportJourneyDocument(ctx, journey.id, { db });
      expect(killed.ok && killed.value).toMatchObject({ sourceVersion: 3, draft: { settings: { emailStyle: NAVY } } });

      // Published on the brand's: no key, as for a journey that never had one.
      vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
      storeStyle(db, journey.id, null);
      await publishLifecycleJourney(ctx, journey.id, { db, nowMs: T });
      const brand = await exportJourneyDocument(ctx, journey.id, { db });
      expect(brand.ok && brand.value.draft.settings).not.toHaveProperty("emailStyle");
    });

    it("a damaged style reads as none: it exports and imports without one, and nothing fails", async () => {
      const { db, journey } = await world();
      storeStyle(db, journey.id, { headerColor: "navy", accentColor: "#ff6b35" });
      const exported = await exportJourneyDocument(ctx, journey.id, { which: "draft", db });
      if (!exported.ok) throw new Error(exported.error);
      expect(exported.value.draft.settings).not.toHaveProperty("emailStyle");

      const doc = JSON.parse(JSON.stringify(exported.value));
      doc.draft.settings.emailStyle = "navy";
      const imported = await importJourneyDocument(ctx, { connectionId: CONNECTION_ID, document: doc }, { db });
      if (!imported.ok) throw new Error(imported.error);
      expect((db.raw("lifecycle_journeys", imported.value.journeyId) as Raw).draft.settings).not.toHaveProperty("emailStyle");
    });
  });

  it("can't reach another account's journeys or connections", async () => {
    const { db, journey } = await world();
    const other: TenantContext = { ...ctx, tenantId: "ten_other" };
    expect(await exportJourneyDocument(other, journey.id, { db })).toMatchObject({ ok: false, status: 404 });
    expect(await duplicateJourney(other, journey.id, { connectionId: CONNECTION_ID }, { db })).toMatchObject({ ok: false, status: 404 });
  });
});
