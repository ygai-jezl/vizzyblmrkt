import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { recordEmailEvent } from "@/lib/email/events";
import { eraseProductUser } from "@/lib/connect/erase";
import { enrolUser, enrolmentDocId } from "@/lib/lifecycle/enrol";
import { processEnrolment } from "@/lib/lifecycle/runner";
import { CONNECTION_ID, T0, contextStub, ctx, productContext, publishOnboarding, seedUser, seedWorld, sendStub, system } from "@/lib/lifecycle/testing/fixtures";
import { forTenant } from "@/lib/tenant";
import { loadPersonBrief } from "./personBrief";
import { loadPersonRecord } from "./personRecord";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
  process.env.LIFECYCLE_MODE_CEILING = "live";
  process.env.LIFECYCLE_SEND_TRACKING = "true";
});
afterEach(() => {
  delete process.env.EMAIL_LINK_ORIGIN;
  delete process.env.LIFECYCLE_MODE_CEILING;
  delete process.env.LIFECYCLE_SEND_TRACKING;
});

/** Priya, whose product has put her name and address into a fact, a trait and her brand's name. */
async function world() {
  const db = new FakeFirestore();
  seedWorld(db);
  const user = seedUser(db, "user_8841", {
    email: "priya.raman@harbour.test",
    emailNormalized: "priya.raman@harbour.test",
    firstName: "Priya",
    lastName: "Raman",
    signedUpAt: iso(T0),
    traits: { plan: "free", nickname: "Priya R" },
    facts: {
      reports_run: { value: 3, at: iso(T0) },
      account_owner: { value: "Priya Raman <priya.raman@harbour.test>", at: iso(T0) },
      // The product quoting its own ids inside a value.
      account_ref: { value: "user_8841 / brand_771", at: iso(T0) },
    },
    entities: {
      brand_771: { kind: "brand", name: "Priya's Bakery", parentId: null, role: "owner", steps: {}, facts: {}, activeAt: null, firstSeenAt: iso(T0), updatedAt: iso(T0) },
    },
  });
  const { journey, version } = await publishOnboarding(db, { testUserIds: ["user_8841"] });
  await enrolUser(system, { journey, version, user, source: "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 });
  const id = enrolmentDocId(journey.id, user.id);
  let now = T0;
  const deps = { db, now: () => now, send: sendStub().send, fetchContext: contextStub(() => productContext()).fetchContext };
  await processEnrolment(system, id, deps);
  now = T0 + 15 * MIN;
  expect(await processEnrolment(system, id, deps)).toBe("sent");
  const event = { campaignId: "", recipientKind: "product_user" as const, connectionId: CONNECTION_ID, enrolmentId: id, journeyId: journey.id, nodeId: "email_welcome", signupId: user.id, variantId: "w" };
  await recordEmailEvent(system, { ...event, type: "open", ts: iso(T0 + 20 * MIN) }, db);
  await recordEmailEvent(system, { ...event, type: "click", ts: iso(T0 + 21 * MIN), url: "https://app.example.com/brand/brand_771/site?invite=priya.raman@harbour.test#user_8841" }, db);
  return { db, user, journey };
}

describe("loadPersonBrief", () => {
  it("gives Vizzy the person's situation", async () => {
    const w = await world();
    const r = await loadPersonBrief(ctx, w.user.id, { db: w.db, nowMs: T0 + 30 * MIN });
    if (!r.found) throw new Error("not found");
    const b = r.brief;
    expect(b).toMatchObject({ personId: w.user.id, product: "Sandbox", testUser: false, today: "2026-09-21", signedUp: "2026-09-21", lastActive: null });
    expect(b.stage).toMatchObject({ kind: "new", stepsDone: 0, stepsTotal: 3, nextStep: "Add your brand" });
    expect(b.canEmail).toEqual({ can: "yes", marketing: true, why: null });
    expect(b.emails).toEqual({ sent: 1, opened: 1, clicked: 1, tracked: 1, trackedClicks: 1 });
    const [j] = b.journeys;
    expect(j).toMatchObject({ journeyId: w.journey.id, name: "Onboarding", status: "active", mode: "test", stopped: null, held: null, then: "finishes" });
    // The email by its name in the journey, the click as a path alone.
    expect(j!.sent).toEqual([{ email: "W · Welcome", on: "2026-09-21", opened: true, clicked: true, clickedPath: "app.example.com/brand/:id/site", wording: null, aiLine: null, note: null }]);
    expect(j!.ahead[0]).toMatchObject({ email: "R1 · Next step", willSend: true, hasAiLine: true });
    // Only the trait the catalog declares.
    expect(b.traits).toEqual([{ label: "Plan", value: "free" }]);
  });

  it("never carries their name, their address or the product's ids", async () => {
    const w = await world();
    const r = await loadPersonBrief(ctx, w.user.id, { db: w.db, nowMs: T0 + 30 * MIN });
    if (!r.found) throw new Error("not found");
    const text = JSON.stringify(r.brief);
    for (const secret of ["Priya", "priya", "Raman", "harbour.test", "user_8841", "brand_771", "Welcome to Sandbox"]) {
      expect(text, `the brief leaks ${secret}`).not.toContain(secret);
    }
    // What the product put the name and address into is still there, without them.
    expect(r.brief.has[0]).toMatchObject({ kind: "brand", name: "[name]'s Bakery" });
    expect(r.brief.facts).toEqual([
      { label: "reports_run", value: "3" },
      { label: "account_owner", value: "[name] [name] <[email]>" },
      { label: "account_ref", value: "[id] / [id]" },
    ]);
  });

  it("gives a date as a plain day, so a person called May keeps the month", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const repo = forTenant(system, db).productConnections;
    const connection = (await repo.getById(CONNECTION_ID))!;
    await repo.update(CONNECTION_ID, { catalog: { ...connection.catalog, facts: [{ id: "trial_ends_at", label: "Trial ends", type: "date", unit: null, description: "", source: "" }] } });
    const user = seedUser(db, "user_52", { firstName: "May", lastName: "August", email: "may@harbour.test", emailNormalized: "may@harbour.test", facts: { trial_ends_at: { value: "2026-05-15", at: iso(T0) } } });
    const page = await loadPersonRecord(ctx, user.id, { db, nowMs: T0 });
    expect(page.found && page.person.facts).toMatchObject([{ label: "Trial ends", value: "15 May 2026", day: "2026-05-15" }]);
    const r = await loadPersonBrief(ctx, user.id, { db, nowMs: T0 });
    expect(r.found && r.brief.facts).toEqual([{ label: "Trial ends", value: "2026-05-15" }]);
    // The stage's own wording keeps its "may"; her name, written as one, still goes.
    expect(r.found && JSON.stringify(r.brief)).not.toMatch(/\bMay\b|August/);
  });

  it("finds nobody for another brand or once they're erased", async () => {
    const w = await world();
    expect(await loadPersonBrief({ ...ctx, tenantId: "ten_other" }, w.user.id, { db: w.db })).toEqual({ found: false, erased: false });
    await eraseProductUser(ctx, CONNECTION_ID, w.user.id, w.db);
    expect(await loadPersonBrief(ctx, w.user.id, { db: w.db })).toEqual({ found: false, erased: true });
  });
});
