import { describe, it, expect } from "vitest";
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
