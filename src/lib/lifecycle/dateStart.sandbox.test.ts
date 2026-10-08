import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { __resetConnectionCaches } from "@/lib/connect/connectionAuth";
import { createProductConnection, fireSandbox } from "@/lib/connect/adminApi";
import { productUserDocId } from "@/lib/connect/profile";
import type { EmailMessage } from "@/lib/email";
import { DATE_PASSED_EVENT, type LifecycleDraft } from "@/lib/types/lifecycle";
import { checkJourneyDates, runNow } from "./adminApi";
import { createLifecycleJourney, publishLifecycleJourney, saveLifecycleDraft } from "./service";

/**
 * The click-through on a Sandbox, end to end through the admin API: the test
 * user goes quiet, "Check now" takes them into a journey that starts when a
 * date passes, the first email goes, they come back, and the journey stops.
 */

const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", role: "admin", email: "jez@yougrow.test", userId: "usr_1" };
const USER = "sandbox_alex";

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  __resetConnectionCaches();
  process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
  process.env.CONNECT_DATE_FACTS = "true";
  process.env.LIFECYCLE_DATE_START = "true";
});
afterEach(() => {
  for (const k of ["EMAIL_LINK_ORIGIN", "CONNECT_DATE_FACTS", "LIFECYCLE_DATE_START"]) delete process.env[k];
});

async function sandbox(db: FakeFirestore) {
  const r = await createProductConnection(ctx, { name: "Sandbox", kind: "sandbox" }, { origin: "https://yougrow.test", db });
  return (r.body as { connection: { id: string; catalog: { facts: Array<{ id: string; type: string }> } } }).connection;
}
const fire = (db: FakeFirestore, id: string, action: Record<string, unknown>) => fireSandbox(ctx, id, { userId: USER, action }, { db });

/** Two emails two days apart, starting when Last active was 14 or more days ago. */
function nudge(blank: LifecycleDraft): LifecycleDraft {
  const at = (x: number) => ({ x, y: 0 });
  const email = (id: string, subject: string) => ({ id, label: subject, subject, body: "<p>Hello {{user.first_name|there}}, here's what's new in {{product.name}}.</p>", format: "letter" as const, messageClass: "service" as const, personalization: "none" as const });
  return {
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", position: at(0), data: { label: "Gone quiet" } },
        { id: "email_1", type: "email", position: at(200), data: { poolId: "nudge" } },
        { id: "wait_1", type: "wait", position: at(400), data: { wait: { minHours: 40, differentLocalDay: true } } },
        { id: "email_2", type: "email", position: at(600), data: { poolId: "nudge" } },
        { id: "exit", type: "exit", position: at(800), data: { label: "End" } },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "email_1", sourceHandle: null },
        { id: "e2", source: "email_1", target: "wait_1", sourceHandle: null },
        { id: "e3", source: "wait_1", target: "email_2", sourceHandle: null },
        { id: "e4", source: "email_2", target: "exit", sourceHandle: null },
      ],
    },
    pools: [{ id: "nudge", label: "Nudge", items: [email("n1", "We saved your place"), email("n2", "One more thing")] }],
    settings: { ...blank.settings, trigger: { event: DATE_PASSED_EVENT, maxEventAgeHours: 72, date: { fact: "last_active_at", days: 14, windowDays: 7, stopWhenDateMoves: true, reenterAfterDays: 30 } } },
  };
}

describe("a nudge journey on a Sandbox, start to stop", () => {
  it("a new sandbox's catalog has the date fact only where date facts are on", async () => {
    expect((await sandbox(new FakeFirestore())).catalog.facts).toContainEqual(expect.objectContaining({ id: "last_active_at", type: "date" }));
    delete process.env.CONNECT_DATE_FACTS;
    const db = new FakeFirestore();
    const off = await sandbox(db);
    expect(off.catalog.facts.map((f) => f.id)).not.toContain("last_active_at");
    expect(await fire(db, off.id, { kind: "last_active", daysAgo: 15 })).toMatchObject({ status: 409, body: { error: "no_last_active_fact" } });
  });

  it("goes quiet, is taken by Check now, gets the first email, comes back, and is stopped", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctx, db);
    const connection = await sandbox(db);
    const sent: EmailMessage[] = [];
    const send = async (m: EmailMessage) => {
      sent.push(m);
      return { sent: true as const, provider: "mandrill" as const, id: "m_1" };
    };

    // The journey: built on a blank draft, published in test mode (a sandbox's own test user is its test recipient).
    const created = await createLifecycleJourney(ctx, { name: "Come back", connectionId: connection.id, template: "blank" }, { db });
    if (!created.ok) throw new Error(created.error);
    const journeyId = created.value.journey.id;
    const saved = await saveLifecycleDraft(ctx, journeyId, nudge(created.value.journey.draft), { db });
    expect(saved.ok && saved.value.issues).toEqual([]);
    expect((await publishLifecycleJourney(ctx, journeyId, { db })).ok).toBe(true);

    // The test user signs up, active today: the check leaves them alone.
    await fire(db, connection.id, { kind: "signed_up" });
    await fire(db, connection.id, { kind: "last_active", daysAgo: 0 });
    expect(await checkJourneyDates(ctx, journeyId, { db })).toMatchObject({ status: 200, body: { checked: 1, enrolled: 0 } });

    // "Went quiet 15 days ago": the date is pushed as state, and the sandbox's context endpoint serves the same.
    expect((await fire(db, connection.id, { kind: "last_active", daysAgo: 15 })).status).toBe(200);
    const user = db.raw("product_users", productUserDocId(connection.id, USER)) as { facts: Record<string, { value: string }> };
    const quietSince = user.facts.last_active_at!.value;
    expect(Date.now() - Date.parse(quietSince)).toBeGreaterThanOrEqual(15 * 86_400_000);
    expect((await repo.productConnections.getById(connection.id))!.sandbox!.users[0]!.facts).toContainEqual({ id: "last_active_at", label: "Last active", value: quietSince, unit: null });

    // "Check now" takes them; running it again takes nobody twice.
    expect(await checkJourneyDates(ctx, journeyId, { db })).toMatchObject({ status: 200, body: { checked: 1, enrolled: 1, finished: true } });
    expect(await checkJourneyDates(ctx, journeyId, { db })).toMatchObject({ body: { enrolled: 0 } });
    const [enrolment] = await repo.lifecycleEnrolments.find({ where: [["journeyId", "==", journeyId]], limit: 5 });
    expect(enrolment).toMatchObject({ externalUserId: USER, status: "active", source: "trigger", dateAt: new Date(quietSince).toISOString() });

    // The first email goes ("Run next step now" skips the send window in test mode).
    expect(await runNow(ctx, enrolment!.id, { db, send })).toMatchObject({ status: 200, body: { outcome: "sent" } });
    expect(sent.map((m) => m.subject)).toEqual(["We saved your place"]);

    // "Came back just now": the next step stops the journey instead of sending the second email.
    await fire(db, connection.id, { kind: "last_active", daysAgo: 0 });
    expect(await runNow(ctx, enrolment!.id, { db, send })).toMatchObject({ status: 200, body: { outcome: "exited" } });
    expect(await repo.lifecycleEnrolments.getById(enrolment!.id)).toMatchObject({ status: "exited", stopReason: "date_moved" });
    expect(sent).toHaveLength(1);
  });
});
