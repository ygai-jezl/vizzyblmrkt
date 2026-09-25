import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import {
  enrolByHand,
  getJourneyDetail,
  journeyAnalytics,
  listEnrolments,
  listJourneys,
  previewJourney,
  runNow,
  stopEnrolment,
} from "./adminApi";
import { enrolmentDocId } from "./enrol";
import { createConnection } from "@/lib/connect/keys";
import { __resetIngestCaches } from "@/lib/connect/ingestHttp";
import { productUserDocId } from "@/lib/connect/profile";
import { SANDBOX_CATALOG } from "@/lib/connect/sandbox";
import { processEnrolment } from "./runner";
import { CONNECTION_ID, T0, contextStub, ctx, productContext, publishOnboarding, seedUser, seedWorld, sendStub, system } from "./testing/fixtures";

const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
  process.env.LIFECYCLE_MODE_CEILING = "live";
});
afterEach(() => {
  delete process.env.EMAIL_LINK_ORIGIN;
  delete process.env.LIFECYCLE_MODE_CEILING;
});

async function setup() {
  const db = new FakeFirestore();
  seedWorld(db);
  const user = seedUser(db, "alex");
  const { journey } = await publishOnboarding(db, { mode: "test", testUserIds: ["alex"] });
  return { db, user, journey };
}

describe("lifecycle admin API", () => {
  it("lists journeys with their product's name, and the products to build on", async () => {
    const { db, journey } = await setup();
    const r = await listJourneys(ctx, {}, db);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      journeys: [{ id: journey.id, connectionName: "Sandbox", status: "active", deliveryMode: "test", publishedVersion: 1 }],
      connections: [{ id: CONNECTION_ID, stepCount: 3 }],
    });
  });

  it("returns the journey with its catalog, sender status and no issues", async () => {
    const { db, journey } = await setup();
    const r = await getJourneyDetail(ctx, journey.id, db);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      connection: { id: CONNECTION_ID, contextConfigured: true },
      version: { version: 1 },
      issues: [],
      sender: { verified: true, fromEmail: "jez@sandbox.test" },
      postalAddress: "1 High Street, London",
      modeCeiling: "live",
    });
    expect(JSON.stringify(r.body)).not.toContain("secretEnc");
  });

  it("enrols a known user by hand, once", async () => {
    const { db, journey, user } = await setup();
    const r = await enrolByHand(ctx, journey.id, { userId: "alex" }, db, T0);
    expect(r).toEqual({ status: 201, body: { enrolmentId: enrolmentDocId(journey.id, user.id) } });
    expect(await enrolByHand(ctx, journey.id, { userId: "alex" }, db, T0)).toMatchObject({ status: 409, body: { error: "already_enrolled" } });
    expect(await enrolByHand(ctx, journey.id, { userId: "nobody" }, db, T0)).toMatchObject({ status: 404, body: { error: "user_not_found" } });
    const list = await listEnrolments(ctx, journey.id, {}, db);
    expect(list.body).toMatchObject({ enrolments: [{ externalUserId: "alex", source: "manual", user: { email: "alex@customer.test" } }] });
  });

  it("stops an active enrolment", async () => {
    const { db, journey } = await setup();
    const r = await enrolByHand(ctx, journey.id, { userId: "alex" }, db, T0);
    const id = (r.body as { enrolmentId: string }).enrolmentId;
    const stopped = await stopEnrolment(ctx, id, db, T0 + 1000);
    expect(stopped).toMatchObject({ status: 200, body: { enrolment: { status: "exited", stopReason: "stopped_by_admin" } } });
    expect(await stopEnrolment(ctx, id, db, T0 + 2000)).toMatchObject({ status: 409, body: { error: "not_active" } });
  });

  it("previews the draft's timeline for an imagined user", async () => {
    const { db, journey } = await setup();
    const r = await previewJourney(ctx, journey.id, { timezone: "Europe/London", anchorAt: iso(T0), stepsDoneAfterHours: { create_brand: 1, run_audit: 20, monitor_prompts: 30 } }, db, T0);
    expect(r.status).toBe(200);
    const body = r.body as { timezone: string; steps: Array<{ kind: string; label: string; day: number }> };
    expect(body.timezone).toBe("Europe/London");
    const sends = body.steps.filter((s) => s.kind === "send").map((s) => s.label);
    expect(sends[0]).toBe("W · Welcome");
    expect(sends).toContain("E1 · Reading your results");
    expect(body.steps.at(-1)?.kind).toMatch(/complete|exit/);
  });

  it("run-now works through the API for a test enrolment", async () => {
    const { db, journey } = await setup();
    const { enrolmentId } = (await enrolByHand(ctx, journey.id, { userId: "alex" }, db, T0)).body as { enrolmentId: string };
    const sends = sendStub();
    const r = await runNow(system, enrolmentId, { db, now: () => T0 + 60_000, send: sends.send, fetchContext: contextStub(() => productContext()).fetchContext });
    // A fresh enrolment is parked at the welcome's 15-minute wait: run-now skips it.
    expect(r).toEqual({ status: 200, body: { outcome: "sent" } });
    expect(sends.sent.map((m) => m.subject)).toEqual(["Welcome to Sandbox, Alex"]);
  });

  it("reports per-email sends and the onboarding goal", async () => {
    const { db, journey, user } = await setup();
    await enrolByHand(ctx, journey.id, { userId: "alex" }, db, T0);
    const id = enrolmentDocId(journey.id, user.id);
    const sends = sendStub();
    const deps = { db, send: sends.send, fetchContext: contextStub(() => productContext()).fetchContext };
    await processEnrolment(system, id, { ...deps, now: () => T0 });
    await processEnrolment(system, id, { ...deps, now: () => T0 + 15 * 60_000 });
    await forTenant(system, db).productUsers.update(user.id, {
      steps: { create_brand: { doneAt: iso(T0 + 3600_000) }, run_audit: { doneAt: iso(T0 + 7200_000) }, monitor_prompts: { doneAt: iso(T0 + 10 * 3600_000) } },
    });
    const r = await journeyAnalytics(ctx, journey.id, db);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enrolments: { total: 1, active: 1 },
      items: [{ poolId: "welcome", itemId: "w", label: "W · Welcome", sent: 1, byMode: { test: 1 } }],
      goal: { eligible: 1, reached: 1, rate: 1, medianHoursToOnboarded: 10 },
    });
  });

  it("is tenant-scoped", async () => {
    const { db, journey } = await setup();
    const other = { ...ctx, tenantId: "ten_other" };
    expect((await getJourneyDetail(other, journey.id, db)).status).toBe(404);
    expect((await enrolByHand(other, journey.id, { userId: "alex" }, db)).status).toBe(404);
    expect((await journeyAnalytics(other, journey.id, db)).status).toBe(404);
  });

  it("enrols a Sandbox test user the Sandbox hasn't sent yet, via the real ingest path", async () => {
    process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
    process.env.LIFECYCLE_INGEST_ENABLED = "true";
    __resetIngestCaches();
    const db = new FakeFirestore();
    seedWorld(db);
    const { connection } = await createConnection(
      ctx,
      {
        name: "Sandbox",
        kind: "sandbox",
        catalog: SANDBOX_CATALOG,
        sandboxUsers: [{ userId: "sandbox_alex", email: "jez@sandbox.test", firstName: "Alex", timezone: "Europe/London", steps: {}, facts: [], insights: [] }],
      },
      db,
    );
    const { journey } = await publishOnboarding(db, { mode: "test", testUserIds: ["sandbox_alex"], connectionId: connection.id });

    // Not a product user yet: nothing has been sent from the Sandbox.
    expect(await forTenant(ctx, db).productUsers.getById(productUserDocId(connection.id, "sandbox_alex"))).toBeNull();

    const r = await enrolByHand(ctx, journey.id, { userId: "sandbox_alex" }, db, T0);
    expect(r.status).toBe(201);
    expect(await forTenant(ctx, db).productUsers.getById(productUserDocId(connection.id, "sandbox_alex"))).toMatchObject({
      email: "jez@sandbox.test",
    });
    // Anyone who isn't one of the Sandbox's test users is still refused.
    expect(await enrolByHand(ctx, journey.id, { userId: "stranger" }, db, T0)).toMatchObject({ status: 404, body: { error: "user_not_found" } });
    delete process.env.LIFECYCLE_INGEST_ENABLED;
  });
});
