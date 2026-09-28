import { describe, it, expect, afterEach, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import {
  createLifecycleJourney,
  publishLifecycleJourney,
  saveLifecycleDraft,
  setLifecycleJourneyStatus,
  updateLifecycleDelivery,
} from "./service";
import { CONNECTION_ID, ctx, seedWorld, system } from "./testing/fixtures";

async function created(db: FakeFirestore, template: "product_onboarding" | "blank" = "product_onboarding") {
  const r = await createLifecycleJourney(ctx, { name: "Onboarding", connectionId: CONNECTION_ID, template }, { db });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("lifecycle journey service", () => {
  it("creates a valid draft from the onboarding template, in test mode", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey, issues } = await created(db);
    expect(issues).toEqual([]);
    expect(journey).toMatchObject({ status: "draft", deliveryMode: "test", publishedVersion: null, shadowInbox: "jez@sandbox.test" });
    expect(journey.draft.pools.map((p) => p.id)).toEqual(["welcome", "reminders", "education", "recap", "last_note"]);
  });

  it("refuses an unknown or revoked connection", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await createLifecycleJourney(ctx, { name: "X", connectionId: "pcn_nope" }, { db });
    expect(r).toMatchObject({ ok: false, status: 404, error: "connection_not_found" });
  });

  it("publishes immutable versions; editing the draft never changes a published one", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db);
    const v1 = await publishLifecycleJourney(ctx, journey.id, { db });
    if (!v1.ok) throw new Error(v1.error);
    expect(v1.value.journey).toMatchObject({ status: "active", publishedVersion: 1 });

    const draft = structuredClone(journey.draft);
    draft.pools[0]!.items[0]!.subject = "Edited from chat";
    const saved = await saveLifecycleDraft(ctx, journey.id, draft, { db, authoredBy: "agent" });
    expect(saved.ok).toBe(true);
    const stored = await forTenant(system, db).lifecycleVersions.getById(`${journey.id}_v1`);
    expect(stored!.pools[0]!.items[0]!.subject).not.toBe("Edited from chat");
    const after = await forTenant(system, db).lifecycleJourneys.getById(journey.id);
    expect(after).toMatchObject({ publishedVersion: 1, authoredBy: "agent" });

    const v2 = await publishLifecycleJourney(ctx, journey.id, { db });
    expect(v2.ok && v2.value.version).toMatchObject({ version: 2, id: `${journey.id}_v2` });
  });

  it("won't publish a broken journey, and says why", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db, "blank");
    const r = await publishLifecycleJourney(ctx, journey.id, { db });
    expect(r).toMatchObject({ ok: false, status: 422, error: "invalid_journey" });
    expect(!r.ok && (r.detail as Array<{ code: string }>).map((i) => i.code)).toContain("no_email");
  });

  it("rejects a malformed draft", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db);
    const r = await saveLifecycleDraft(ctx, journey.id, { graph: { nodes: "nope" } }, { db });
    expect(r).toMatchObject({ ok: false, status: 400, error: "invalid_draft" });
  });

  it("a draft whose layout button carries a styleSource from a later build still publishes, with the button as built", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db);
    // The draft as a rolled-back build would have left it: past the schema, straight into the doc.
    const raw = structuredClone(db.raw("lifecycle_journeys", journey.id)) as {
      draft: { pools: Array<{ items: Array<Record<string, unknown>> }> };
    };
    raw.draft.pools[0]!.items[0]!.layout = {
      blocks: [
        { id: "t1", kind: "text", role: "copy", html: "<p>Hi {{user.first_name|there}}</p>" },
        { id: "b1", kind: "button", label: "Open the app", href: "https://app.example.com/", bg: "#4f46e5", radius: 6, styleSource: "tinted" },
        { id: "b2", kind: "button", label: "Our own", href: "https://app.example.com/own", bg: "#0b1f3a", styleSource: "own" },
        { id: "f1", kind: "footer", text: "" },
      ],
    };
    db.seed("lifecycle_journeys", journey.id, raw);

    const r = await publishLifecycleJourney(ctx, journey.id, { db });
    expect(r.ok).toBe(true);
    const version = await forTenant(system, db).lifecycleVersions.getById(`${journey.id}_v1`);
    const blocks = version!.pools[0]!.items[0]!.layout!.blocks;
    expect(blocks[1]).toMatchObject({ kind: "button", bg: "#4f46e5", color: "#ffffff", radius: 6 });
    expect(blocks[1]!.kind === "button" && blocks[1]!.styleSource).toBeUndefined();
    expect(blocks[2]).toMatchObject({ kind: "button", bg: "#0b1f3a", styleSource: "own" });
  });

  it("can only be activated once published; pausing keeps it paused across publishes", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db);
    expect(await setLifecycleJourneyStatus(ctx, journey.id, "active", { db })).toMatchObject({ ok: false, error: "not_published" });
    await publishLifecycleJourney(ctx, journey.id, { db });
    await setLifecycleJourneyStatus(ctx, journey.id, "paused", { db });
    const again = await publishLifecycleJourney(ctx, journey.id, { db });
    expect(again.ok && again.value.journey.status).toBe("paused");
  });

  it("limits the shadow inbox to the operator's own address or a verified domain", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db);
    const bad = await updateLifecycleDelivery(ctx, journey.id, { deliveryMode: "shadow", shadowInbox: "someone@gmail.com" }, { db });
    expect(bad).toMatchObject({ ok: false, error: "shadow_inbox_not_allowed" });
    const verified = await updateLifecycleDelivery(ctx, journey.id, { deliveryMode: "shadow", shadowInbox: "ops@sandbox.test" }, { db });
    expect(verified.ok).toBe(true);
    const none = await updateLifecycleDelivery(ctx, journey.id, { deliveryMode: "shadow", shadowInbox: null }, { db });
    expect(none).toMatchObject({ ok: false, error: "shadow_inbox_required" });
  });

  it("live needs the sender on a verified domain", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db);
    const draft = structuredClone(journey.draft);
    draft.settings.sender = { fromName: "Jez", fromEmail: "jez@unverified.test", replyTo: null };
    await saveLifecycleDraft(ctx, journey.id, draft, { db });
    expect(await updateLifecycleDelivery(ctx, journey.id, { deliveryMode: "live" }, { db })).toMatchObject({
      ok: false,
      error: "sender_unverified",
    });
    draft.settings.sender = { fromName: "Jez", fromEmail: "jez@sandbox.test", replyTo: null };
    await saveLifecycleDraft(ctx, journey.id, draft, { db });
    expect((await updateLifecycleDelivery(ctx, journey.id, { deliveryMode: "live" }, { db })).ok).toBe(true);
  });

  it("is tenant-scoped", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db);
    const other: TenantContext = { tenantId: "ten_other", region: "eu", source: "idtoken", role: "admin" };
    expect(await publishLifecycleJourney(other, journey.id, { db })).toMatchObject({ ok: false, status: 404 });
    expect(await saveLifecycleDraft(other, journey.id, journey.draft, { db })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("a journey's own email style: kept by draft saves, made live by publish", () => {
  const NAVY = { headerColor: "#0b1f3a", accentColor: "#ff6b35" };
  const TEAL = { headerColor: "#0f766e", accentColor: "#f59e0b", headerText: "white" };
  afterEach(() => vi.unstubAllEnvs());

  type RawJourney = { draft: { settings: Record<string, unknown> }; emailStyle?: unknown };
  const raw = (db: FakeFirestore, id: string) => db.raw("lifecycle_journeys", id) as RawJourney;
  /** Put a style straight into the stored draft, as the editor or Vizzy's journey-style kind will. */
  function storeStyle(db: FakeFirestore, id: string, style: unknown) {
    const doc = structuredClone(raw(db, id));
    doc.draft.settings.emailStyle = style;
    db.seed("lifecycle_journeys", id, doc);
  }

  it("a draft save keeps the stored style, whatever its body says about one, with the flag on or off", async () => {
    for (const flag of ["true", "false"]) {
      vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", flag);
      const db = new FakeFirestore();
      seedWorld(db);
      const { journey } = await created(db);
      storeStyle(db, journey.id, NAVY);
      for (const echo of [undefined, null, "navy", { headerColor: "navy" }, TEAL]) {
        const draft = structuredClone(journey.draft);
        draft.pools[0]!.items[0]!.subject = `Edited ${String(echo)}`;
        const body = echo === undefined ? draft : { ...draft, settings: { ...draft.settings, emailStyle: echo } };
        const saved = await saveLifecycleDraft(ctx, journey.id, body, { db, authoredBy: "agent" });
        expect(saved.ok).toBe(true);
        expect(raw(db, journey.id).draft.settings.emailStyle).toEqual(NAVY);
        expect(saved.ok && saved.value.journey.draft.settings.emailStyle).toEqual(NAVY);
      }
      // …and a journey without one stays without one: no key.
      const { journey: plain } = await created(db);
      await saveLifecycleDraft(ctx, plain.id, { ...plain.draft, settings: { ...plain.draft.settings, emailStyle: NAVY } }, { db });
      expect(raw(db, plain.id).draft.settings).not.toHaveProperty("emailStyle");
    }
  });

  it("a style saved between a draft save's read and its write isn't lost", async () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db);
    const draft = structuredClone(journey.draft);
    draft.pools[0]!.items[0]!.subject = "Edited from chat";
    // Vizzy's journey-style kind lands after this save read the journey, before it commits.
    db.onBeforeCommit = async () => {
      await forTenant(system, db).lifecycleJourneys.claim(journey.id, (cur) => ({
        draft: { ...cur.draft, settings: { ...cur.draft.settings, emailStyle: NAVY } },
      }));
    };
    const saved = await saveLifecycleDraft(ctx, journey.id, draft, { db, authoredBy: "agent" });
    expect(saved.ok).toBe(true);
    const after = raw(db, journey.id) as RawJourney & { draft: { pools: Array<{ items: Array<{ subject: string }> }> } };
    expect(after.draft.settings.emailStyle).toEqual(NAVY);
    expect(after.draft.pools[0]!.items[0]!.subject).toBe("Edited from chat");
  });

  it("a journey archived between a draft save's read and its write isn't written", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db);
    db.onBeforeCommit = async () => {
      await forTenant(system, db).lifecycleJourneys.update(journey.id, { status: "archived" });
    };
    const draft = structuredClone(journey.draft);
    draft.pools[0]!.items[0]!.subject = "Too late";
    expect(await saveLifecycleDraft(ctx, journey.id, draft, { db })).toMatchObject({ ok: false, status: 404, error: "not_found" });
    expect(JSON.stringify(raw(db, journey.id).draft)).not.toContain("Too late");
  });

  it("with the flag on, publish makes the draft's style live, and a draft on the brand's clears it", async () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db);
    storeStyle(db, journey.id, TEAL);
    const v1 = await publishLifecycleJourney(ctx, journey.id, { db });
    expect(v1.ok && v1.value.journey.emailStyle).toEqual(TEAL);
    expect(raw(db, journey.id).emailStyle).toEqual(TEAL);
    const version1 = (await forTenant(system, db).lifecycleVersions.getById(`${journey.id}_v1`))!;
    expect(version1.settings.emailStyle).toEqual(TEAL);

    // Saved to the draft only: the live style doesn't move until the next publish.
    storeStyle(db, journey.id, NAVY);
    expect(raw(db, journey.id).emailStyle).toEqual(TEAL);

    storeStyle(db, journey.id, null);
    const v2 = await publishLifecycleJourney(ctx, journey.id, { db });
    expect(v2.ok && v2.value.journey.emailStyle).toBeNull();
    expect(raw(db, journey.id).emailStyle).toBeNull();
    const version2 = (await forTenant(system, db).lifecycleVersions.getById(`${journey.id}_v2`))!;
    expect(version2.settings).not.toHaveProperty("emailStyle");

    // A damaged draft style reads as none: it publishes, on the brand's.
    storeStyle(db, journey.id, { headerColor: "navy", accentColor: "#ff6b35" });
    const v3 = await publishLifecycleJourney(ctx, journey.id, { db });
    expect(v3.ok && v3.value.journey.emailStyle).toBeNull();
  });

  it("with the flag off, publish writes no email style: not on the journey, not in the version", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await created(db);
    storeStyle(db, journey.id, TEAL);
    const before = structuredClone(raw(db, journey.id));
    const v1 = await publishLifecycleJourney(ctx, journey.id, { db });
    expect(v1.ok).toBe(true);
    expect(v1.ok && v1.value.journey).not.toHaveProperty("emailStyle");
    expect(raw(db, journey.id)).not.toHaveProperty("emailStyle");
    expect(raw(db, journey.id).draft).toEqual(before.draft);
    const version = db.raw("lifecycle_versions", `${journey.id}_v1`) as { settings: Record<string, unknown> };
    expect(version.settings).not.toHaveProperty("emailStyle");
  });
});
