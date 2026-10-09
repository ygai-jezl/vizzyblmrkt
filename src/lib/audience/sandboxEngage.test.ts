import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { enrolUser, enrolmentDocId } from "@/lib/lifecycle/enrol";
import { processEnrolment } from "@/lib/lifecycle/runner";
import { CONNECTION_ID, T0, contextStub, ctx, productContext, publishOnboarding, seedUser, seedWorld, sendStub, system } from "@/lib/lifecycle/testing/fixtures";
import { loadPersonRecord } from "./personRecord";
import { pretendEngagement } from "./sandboxEngage";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
  process.env.LIFECYCLE_MODE_CEILING = "live";
});
afterEach(() => {
  delete process.env.EMAIL_LINK_ORIGIN;
  delete process.env.LIFECYCLE_MODE_CEILING;
  delete process.env.LIFECYCLE_SEND_TRACKING;
});

/** The fixtures' product as a Sandbox whose one test user is Alex, enrolled in onboarding. */
async function sandbox(opts: { welcome?: boolean } = {}) {
  const db = new FakeFirestore();
  seedWorld(db);
  const user = seedUser(db, "alex");
  await forTenant(ctx, db).productConnections.update(CONNECTION_ID, {
    kind: "sandbox",
    sandbox: { users: [{ userId: "alex", email: user.email!, firstName: "Alex", timezone: "Europe/London", steps: {}, facts: [], insights: [] }], webhookInbox: [] },
  });
  const { journey, version } = await publishOnboarding(db, { testUserIds: ["alex"] });
  await enrolUser(system, { journey, version, user, source: "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 });
  const id = enrolmentDocId(journey.id, user.id);
  if (opts.welcome !== false) {
    let now = T0;
    const deps = { db, now: () => now, send: sendStub().send, fetchContext: contextStub(() => productContext()).fetchContext };
    await processEnrolment(system, id, deps);
    now = T0 + 15 * MIN;
    expect(await processEnrolment(system, id, deps)).toBe("sent");
  }
  return { db, user, journey, id };
}

describe("pretendEngagement", () => {
  it("records the open and the click the provider would, and the person's page shows them", async () => {
    const w = await sandbox();
    const opened = await pretendEngagement(ctx, CONNECTION_ID, { userId: "alex", action: "open" }, { db: w.db, nowMs: T0 + 20 * MIN });
    expect(opened).toEqual({ status: 200, body: { ok: true, outcome: "recorded", personId: w.user.id } });
    await pretendEngagement(ctx, CONNECTION_ID, { userId: "alex", action: "click" }, { db: w.db, nowMs: T0 + 21 * MIN });
    // The provider's rows keep the first open: a second one changes nothing.
    expect((await pretendEngagement(ctx, CONNECTION_ID, { userId: "alex", action: "open" }, { db: w.db, nowMs: T0 + 30 * MIN })).body).toMatchObject({ outcome: "duplicate" });

    const r = await loadPersonRecord(ctx, w.user.id, { db: w.db, nowMs: T0 + 40 * MIN });
    expect(r.found && r.person.emails[0]).toMatchObject({ label: "W · Welcome", openedAt: iso(T0 + 20 * MIN), clickedAt: iso(T0 + 21 * MIN), clickUrl: "https://example.com/" });
    expect(r.found && r.person.emailCounts).toMatchObject({ sent: 1, opened: 1, clicked: 1 });
  });

  it("names the enrolment when the email did", async () => {
    process.env.LIFECYCLE_SEND_TRACKING = "true";
    const w = await sandbox();
    await pretendEngagement(ctx, CONNECTION_ID, { userId: "alex", action: "open" }, { db: w.db, nowMs: T0 + 20 * MIN });
    const rows = await forTenant(system, w.db).emailEvents.find({ where: [["signupId", "==", w.user.id]] });
    expect(rows.map((r) => [r.type, r.enrolmentId]).sort()).toEqual([
      ["open", w.id],
      ["send", w.id],
    ]);
  });

  it("is for a Sandbox's own test users, once they've been sent something", async () => {
    const w = await sandbox({ welcome: false });
    expect(await pretendEngagement(ctx, CONNECTION_ID, { userId: "alex", action: "open" }, { db: w.db })).toMatchObject({ status: 409, body: { error: "no_email_sent" } });
    expect(await pretendEngagement(ctx, CONNECTION_ID, { userId: "someone_else", action: "open" }, { db: w.db })).toMatchObject({ status: 404, body: { error: "user_not_found" } });
    expect(await pretendEngagement(ctx, CONNECTION_ID, { userId: "alex", action: "forward" }, { db: w.db })).toMatchObject({ status: 400 });
    await forTenant(ctx, w.db).productConnections.update(CONNECTION_ID, { kind: "custom" });
    expect(await pretendEngagement(ctx, CONNECTION_ID, { userId: "alex", action: "open" }, { db: w.db })).toMatchObject({ status: 400, body: { error: "not_a_sandbox" } });
    expect(await pretendEngagement(ctx, "pcn_nope", { userId: "alex", action: "open" }, { db: w.db })).toMatchObject({ status: 404 });
  });
});
