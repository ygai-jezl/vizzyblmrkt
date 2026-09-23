import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { saveLifecycleDraft } from "./service";
import { duplicateJourney, exportJourneyDocument, importJourneyDocument, JOURNEY_DOCUMENT_FORMAT } from "./transfer";
import { CONNECTION_ID, ctx, publishOnboarding, seedWorld } from "./testing/fixtures";

const T = Date.parse("2026-09-22T12:00:00Z");

beforeEach(() => {
  process.env.LIFECYCLE_MODE_CEILING = "live";
});
afterEach(() => {
  delete process.env.LIFECYCLE_MODE_CEILING;
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

  it("can't reach another account's journeys or connections", async () => {
    const { db, journey } = await world();
    const other: TenantContext = { ...ctx, tenantId: "ten_other" };
    expect(await exportJourneyDocument(other, journey.id, { db })).toMatchObject({ ok: false, status: 404 });
    expect(await duplicateJourney(other, journey.id, { connectionId: CONNECTION_ID }, { db })).toMatchObject({ ok: false, status: 404 });
  });
});
