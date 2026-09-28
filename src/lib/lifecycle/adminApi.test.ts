import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, getTenantById } from "@/lib/tenant";
import { setTenantEmailStyle } from "@/lib/tenant/control";
import { resolveEmailStyle } from "@/lib/email/resolveEmailStyle";
import {
  enrolByHand,
  generateJourneyDraft,
  getJourneyDetail,
  journeyAnalytics,
  listEnrolments,
  listJourneys,
  previewJourney,
  runNow,
  saveDraft,
  stopEnrolment,
} from "./adminApi";
import { enrolmentDocId } from "./enrol";
import { createConnection } from "@/lib/connect/keys";
import { __resetConnectionCaches as __resetIngestCaches } from "@/lib/connect/connectionAuth";
import { productUserDocId } from "@/lib/connect/profile";
import { SANDBOX_CATALOG } from "@/lib/connect/sandbox";
import { processEnrolment } from "./runner";
import { CONNECTION_ID, T0, TENANT_ID, contextStub, ctx, productContext, publishOnboarding, seedUser, seedWorld, sendStub, system } from "./testing/fixtures";
import { publishWaitlist, seedLaunch } from "./waitlist/testing/fixtures";

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

  it("enrols a Sandbox test user the Sandbox hasn't sent yet, via the real API v2 write path", async () => {
    process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
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
  });
});

describe("journey detail: what the previews need to match the send", () => {
  const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
  const STYLE = {
    logo: { id: "logo_1", filename: FILE, width: 120, height: 40 },
    companyName: null,
    headerColor: "#0b1f3a",
    accentColor: "#1d4ed8",
  };
  type Detail = { emailStyle: unknown; footerBrand: string; features: { emailStyle: boolean } };
  afterEach(() => vi.unstubAllEnvs());

  it("flag off: no Email style, even with one saved", async () => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "false");
    const { db, journey } = await setup();
    await setTenantEmailStyle(TENANT_ID, STYLE, db);
    const detail = (await getJourneyDetail(ctx, journey.id, db)).body as Detail;
    expect(detail.emailStyle).toBeNull();
    expect(detail.features.emailStyle).toBe(false);
  });

  it("flag on: the style the send resolves, logo and all", async () => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
    vi.stubEnv("BRAND_KIT_LOGOS_ENABLED", "true");
    const { db, journey } = await setup();
    await setTenantEmailStyle(TENANT_ID, STYLE, db);
    const detail = (await getJourneyDetail(ctx, journey.id, db)).body as Detail;
    expect(detail.features.emailStyle).toBe(true);
    expect(detail.emailStyle).toEqual(resolveEmailStyle(await getTenantById(TENANT_ID, db)));
    expect(detail.emailStyle).toMatchObject({ headerColor: "#0b1f3a", logo: { url: `https://mk.test/api/brand-logo/${TENANT_ID}/${FILE}` } });
  });

  it("footerBrand: the sending name, else the workspace name — never a placeholder", async () => {
    const { db, journey } = await setup();
    expect(((await getJourneyDetail(ctx, journey.id, db)).body as Detail).footerBrand).toBe("Jez at Sandbox");
    const tenant = db.raw("tenants", TENANT_ID)!;
    const { senderName, ...unnamed } = tenant.emailSenderConfig as Record<string, unknown>;
    db.seed("tenants", TENANT_ID, { ...tenant, emailSenderConfig: unnamed });
    expect(((await getJourneyDetail(ctx, journey.id, db)).body as Detail).footerBrand).toBe("Sandbox Co");
  });

  it("a launch's welcome journey: the launch's sender name and the style", async () => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
    const db = new FakeFirestore();
    seedLaunch(db, { emailFromName: "The Fernlight team" });
    const { journey } = await publishWaitlist(db);
    await setTenantEmailStyle(TENANT_ID, STYLE, db);
    const detail = (await getJourneyDetail(ctx, journey.id, db)).body as Detail;
    expect(detail).toMatchObject({ footerBrand: "The Fernlight team", features: { emailStyle: true }, emailStyle: { headerColor: "#0b1f3a" } });
  });
});

describe("the journey's own email style in the editor's draft save", () => {
  const NAVY = { headerColor: "#0b1f3a", accentColor: "#ff6b35" };
  afterEach(() => vi.unstubAllEnvs());

  type RawDraft = { draft: { settings: Record<string, unknown>; pools: Array<{ items: Array<{ subject: string }> }> } };
  const stored = (db: FakeFirestore, id: string) => (db.raw("lifecycle_journeys", id) as RawDraft).draft;
  async function draftOf(db: FakeFirestore, id: string) {
    return structuredClone((await forTenant(system, db).lifecycleJourneys.getById(id))!.draft);
  }
  const withStyle = (draft: Awaited<ReturnType<typeof draftOf>>, emailStyle: unknown) => ({ ...draft, settings: { ...draft.settings, emailStyle } });

  it("sets a valid style, keeps it when the body has none, and goes back to the brand's on null", async () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    const { db, journey } = await setup();
    const draft = await draftOf(db, journey.id);

    const set = await saveDraft(ctx, journey.id, withStyle(draft, { headerColor: "#0B1F3A", accentColor: "#FF6B35", headerGradientColor: "#4F46E5" }), db);
    expect(set.status).toBe(200);
    expect(stored(db, journey.id).settings.emailStyle).toStrictEqual({ ...NAVY, headerGradientColor: "#4f46e5" });

    draft.pools[0]!.items[0]!.subject = "Edited";
    expect((await saveDraft(ctx, journey.id, draft, db)).status).toBe(200);
    expect(stored(db, journey.id).pools[0]!.items[0]!.subject).toBe("Edited");
    expect(stored(db, journey.id).settings.emailStyle).toStrictEqual({ ...NAVY, headerGradientColor: "#4f46e5" });

    expect((await saveDraft(ctx, journey.id, withStyle(draft, null), db)).status).toBe(200);
    expect(stored(db, journey.id).settings).not.toHaveProperty("emailStyle");
  });

  it("refuses a bad style with a 400 naming the field, and writes nothing", async () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    const { db, journey } = await setup();
    const draft = await draftOf(db, journey.id);
    await saveDraft(ctx, journey.id, withStyle(draft, NAVY), db);
    const before = structuredClone(stored(db, journey.id));

    draft.pools[0]!.items[0]!.subject = "Not saved";
    const cases: Array<[unknown, string]> = [
      [{ ...NAVY, headerColor: "navy" }, "settings.emailStyle.headerColor"],
      [{ headerColor: "#0b1f3a" }, "settings.emailStyle.accentColor"],
      [{ ...NAVY, headerText: "auto" }, "settings.emailStyle.headerText"],
      [{ ...NAVY, logo: null }, "settings.emailStyle"],
      ["navy", "settings.emailStyle"],
    ];
    for (const [bad, field] of cases) {
      const r = await saveDraft(ctx, journey.id, withStyle(draft, bad), db);
      expect(r).toMatchObject({ status: 400, body: { error: "invalid_draft" } });
      expect((r.body as { detail: string }).detail.startsWith(`${field}: `)).toBe(true);
    }
    expect(stored(db, journey.id)).toEqual(before);
  });

  it("with the flag off, the draft save keeps what's stored and ignores a style in the body, bad or good", async () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    const { db, journey } = await setup();
    const draft = await draftOf(db, journey.id);
    await saveDraft(ctx, journey.id, withStyle(draft, NAVY), db);
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "false");
    for (const echo of [{ headerColor: "navy" }, { headerColor: "#0f766e", accentColor: "#f59e0b" }, null]) {
      expect((await saveDraft(ctx, journey.id, withStyle(draft, echo), db)).status).toBe(200);
      expect(stored(db, journey.id).settings.emailStyle).toStrictEqual(NAVY);
    }
    // …and a journey without one, today's draft save exactly: no key.
    const { journey: plain } = await publishOnboarding(db);
    await saveDraft(ctx, plain.id, withStyle(await draftOf(db, plain.id), NAVY), db);
    expect(stored(db, plain.id).settings).not.toHaveProperty("emailStyle");
  });

  it("the AI rebuild keeps the style", async () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    const { db, journey } = await setup();
    await saveDraft(ctx, journey.id, withStyle(await draftOf(db, journey.id), NAVY), db);
    const generate = async () =>
      JSON.stringify({ subject: "Rebuilt {{user.first_name|there}}", previewText: "Quick note", body: "<p>Hello {{user.first_name|there}}</p>" });
    const r = await generateJourneyDraft(ctx, journey.id, { brief: "Shorter" }, { db, generate });
    expect(r.status).toBe(200);
    expect(stored(db, journey.id).pools[0]!.items[0]!.subject).toBe("Rebuilt {{user.first_name|there}}");
    expect(stored(db, journey.id).settings.emailStyle).toStrictEqual(NAVY);
  });
});
