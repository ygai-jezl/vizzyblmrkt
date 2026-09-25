import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { suppressEmailCategory } from "@/lib/email/suppression";
import type { EmailResult } from "@/lib/email";
import type { ProductContext } from "@/lib/connect/protocol";
import type { DeliveryMode } from "@/lib/types/lifecycle";
import { enrolUser, enrolmentDocId, counterDocId } from "./enrol";
import { processEnrolment, runEnrolmentNow } from "./runner";
import { publishLifecycleJourney, saveLifecycleDraft, setLifecycleJourneyStatus } from "./service";
import {
  CONNECTION_ID,
  STEPS,
  T0,
  contextStub,
  ctx,
  productContext,
  publishOnboarding,
  seedUser,
  seedWorld,
  sendStub,
  system,
} from "./testing/fixtures";

const MIN = 60_000;
const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ALL_DONE = STEPS.map((s) => s.id);

beforeEach(() => {
  process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
  process.env.LIFECYCLE_MODE_CEILING = "live";
});
afterEach(() => {
  delete process.env.EMAIL_LINK_ORIGIN;
  delete process.env.LIFECYCLE_MODE_CEILING;
});

async function world(
  opts: {
    mode?: DeliveryMode;
    users?: string[];
    testUserIds?: string[];
    shadowInbox?: string | null;
    caps?: { sendsPerDay: number; enrolmentsPerDay: number };
    consent?: "consent" | "none";
  } = {},
) {
  const db = new FakeFirestore();
  seedWorld(db);
  const users = (opts.users ?? ["alex"]).map((u) =>
    seedUser(db, u, opts.consent === "none" ? { consent: { basis: "none", assertedBasis: "none", source: null, at: iso(T0) } } : {}),
  );
  const { journey, version } = await publishOnboarding(db, {
    mode: opts.mode ?? "test",
    testUserIds: opts.testUserIds ?? users.map((u) => u.externalUserId),
    shadowInbox: opts.shadowInbox,
    caps: opts.caps,
  });
  for (const user of users) {
    const r = await enrolUser(system, { journey, version, user, source: "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 });
    expect(r.outcome).toBe("enrolled");
  }

  let now = T0;
  let context: ProductContext | null = productContext();
  let result: (m: unknown) => EmailResult = () => ({ sent: true, provider: "mandrill", id: "m_1" });
  const ctxStub = contextStub(() => context);
  const sends = sendStub((m) => result(m));
  const deps = { db, now: () => now, send: sends.send, fetchContext: ctxStub.fetchContext };
  const idOf = (u = users[0]!) => enrolmentDocId(journey.id, u.id);
  return {
    db,
    journey,
    users,
    sent: sends.sent,
    contextCalls: ctxStub.calls,
    deps,
    setNow: (ms: number) => (now = ms),
    setContext: (c: ProductContext | null) => (context = c),
    setResult: (r: (m: unknown) => EmailResult) => (result = r),
    get: async (u = users[0]!) => (await forTenant(system, db).lifecycleEnrolments.getById(idOf(u)))!,
    run: (at: number, u = users[0]!) => {
      now = at;
      return processEnrolment(system, idOf(u), deps);
    },
  };
}

/** Enrol → the welcome goes out 15 minutes after sign-up. Returns the next run time. */
async function throughWelcome(w: Awaited<ReturnType<typeof world>>): Promise<number> {
  expect(await w.run(T0)).toBe("waiting");
  expect(await w.run(T0 + 15 * MIN)).toBe("sent");
  return Date.parse((await w.get()).nextRunAt!);
}

describe("lifecycle runner", () => {
  it("sends the welcome 15 minutes after sign-up, then waits for the next business morning", async () => {
    const w = await world();
    expect(await w.run(T0)).toBe("waiting");
    expect(w.contextCalls).toHaveLength(0); // a run that only reaches a wait never calls the product
    let e = await w.get();
    expect(e.cursor).toEqual({ nodeId: "email_welcome" });
    expect(e.nextRunAt).toBe(iso(T0 + 15 * MIN));

    expect(await w.run(T0 + 15 * MIN)).toBe("sent");
    expect(w.contextCalls).toEqual([{ userId: "alex", purpose: "send" }]);
    const m = w.sent[0]!;
    expect(m).toMatchObject({
      to: "alex@customer.test",
      subject: "Welcome to Sandbox, Alex",
      fromEmail: "jez@sandbox.test",
      fromName: "Jez at Sandbox",
      replyTo: "jez@sandbox.test",
      track: { opens: false, clicks: false },
      tags: ["lifecycle"],
      metadata: {
        tenantId: "ten_life",
        nodeId: "email_welcome",
        variantId: "w",
        campaignId: "",
        recipientKind: "product_user",
        connectionId: CONNECTION_ID,
        signupId: w.users[0]!.id,
      },
    });
    expect(m.listUnsubscribe?.url).toMatch(/^https:\/\/mk\.test\/api\/unsubscribe\?u=/);
    expect(m.html).toContain("☐");
    expect(m.html).toContain("1 High Street, London");
    expect(m.text).toContain("Unsubscribe (https://mk.test/unsubscribe?u=");

    e = await w.get();
    expect(e.sentItems).toMatchObject([{ nodeId: "email_welcome", poolId: "welcome", itemId: "w", status: "sent", mode: "test" }]);
    expect(e.pendingSend).toBeNull();
    expect(e.leaseId).toBeNull();
    expect(e.cursor).toEqual({ nodeId: "cond_1" });
    // Tuesday 22 Sep, inside the 09:00–10:30 London window.
    const next = Date.parse(e.nextRunAt!);
    expect(next).toBeGreaterThanOrEqual(Date.parse("2026-09-22T08:00:00Z"));
    expect(next).toBeLessThan(Date.parse("2026-09-22T09:30:00Z"));

    const events = await forTenant(system, w.db).emailEvents.find();
    expect(events).toMatchObject([{ type: "send", variantId: "w", recipientKind: "product_user", campaignId: "" }]);
  });

  it("switches to education once onboarding is complete, with the product's insight", async () => {
    const w = await world();
    const next = await throughWelcome(w);
    w.setContext(productContext({ done: ALL_DONE }));
    expect(await w.run(next)).toBe("sent");
    expect(w.sent[1]!.subject).toBe("How to read your first results");
    expect(w.sent[1]!.html).toContain("ChatGPT mentioned you in 3 of 10 answers.");
    const e = await w.get();
    expect(e.sentItems.map((s) => s.itemId)).toEqual(["w", "e1"]);
    expect(e.usedInsightIds).toEqual(["i_sov"]);
    expect(e.cursor).toEqual({ nodeId: "cond_2" });
  });

  it("nudges towards the exact next step while onboarding is incomplete", async () => {
    const w = await world();
    const next = await throughWelcome(w);
    w.setContext(
      productContext({
        done: ["create_brand"],
        nextStep: { id: "run_audit", label: "Run an audit", url: "https://app.example.com/audits?new=1" },
      }),
    );
    await w.run(next);
    const m = w.sent[1]!;
    expect(m.subject).toBe("Your next step: Run an audit");
    expect(m.html).toContain('href="https://app.example.com/audits?new=1"');
    // The insight that supports the next step wins over a heavier one.
    expect(m.html).toContain("Your audit found 4 quick fixes.");
  });

  it("falls back to the stored profile when the product can't be reached", async () => {
    const w = await world();
    const next = await throughWelcome(w);
    w.setContext(null);
    expect(await w.run(next)).toBe("sent");
    const m = w.sent[1]!;
    expect(m.subject).toBe("Your next step: Add your brand");
    expect(m.html).not.toContain("ChatGPT mentioned you");
    const e = await w.get();
    expect(e.log.some((l) => l.event === "context_unavailable")).toBe(true);
  });

  it("two overlapping runs send exactly once", async () => {
    const w = await world();
    await w.run(T0);
    w.setNow(T0 + 15 * MIN);
    const id = enrolmentDocId(w.journey.id, w.users[0]!.id);
    const outcomes = await Promise.all([processEnrolment(system, id, w.deps), processEnrolment(system, id, w.deps)]);
    expect(outcomes.sort()).toEqual(["not_due", "sent"]);
    expect(w.sent).toHaveLength(1);
  });

  it("a send interrupted mid-flight is recorded as unknown and never resent", async () => {
    const w = await world();
    await w.run(T0);
    const id = enrolmentDocId(w.journey.id, w.users[0]!.id);
    await forTenant(system, w.db).lifecycleEnrolments.update(id, {
      pendingSend: { nodeId: "email_welcome", poolId: "welcome", itemId: "w", at: iso(T0 + 15 * MIN) },
      leaseId: "crashed",
      leaseUntil: iso(T0 + 18 * MIN),
    });
    expect(await w.run(T0 + 17 * MIN)).toBe("not_due"); // still leased by the crashed run
    expect(await w.run(T0 + 19 * MIN)).toBe("waiting");
    expect(w.sent).toHaveLength(0);
    const e = await w.get();
    expect(e.sentItems).toMatchObject([{ itemId: "w", status: "unknown", reason: "interrupted" }]);
    expect(e.pendingSend).toBeNull();
    expect(e.cursor).toEqual({ nodeId: "cond_1" });
  });

  it("an ambiguous provider answer counts as sent-unknown and moves on", async () => {
    const w = await world();
    w.setResult(() => ({ sent: false, provider: "mandrill", ambiguous: true, reason: "timeout" }));
    await w.run(T0);
    expect(await w.run(T0 + 15 * MIN)).toBe("sent");
    const e = await w.get();
    expect(e.sentItems).toMatchObject([{ itemId: "w", status: "unknown", reason: "timeout" }]);
    expect(e.cursor).toEqual({ nodeId: "cond_1" });
    expect(await forTenant(system, w.db).emailEvents.find()).toHaveLength(0);
  });

  it("a definite failure gives the day's slot back and retries later", async () => {
    const w = await world();
    w.setResult(() => ({ sent: false, provider: "mandrill", reason: "http_400" }));
    await w.run(T0);
    expect(await w.run(T0 + 15 * MIN)).toBe("failed");
    let e = await w.get();
    expect(e).toMatchObject({ failures: 1, pendingSend: null, cursor: { nodeId: "email_welcome" }, nextRunAt: iso(T0 + 20 * MIN) });
    const counter = await forTenant(system, w.db).lifecycleCounters.getById(counterDocId(w.journey.id, T0));
    expect(counter?.sends).toBe(0);

    w.setResult(() => ({ sent: true, provider: "mandrill", id: "m_2" }));
    expect(await w.run(T0 + 20 * MIN)).toBe("sent");
    e = await w.get();
    expect(e.failures).toBe(0);
    expect(e.sentItems.map((s) => s.status)).toEqual(["sent"]);
  });

  it("an unsubscribe from the category ends the journey", async () => {
    const w = await world();
    const next = await throughWelcome(w);
    await suppressEmailCategory(system, { email: "alex@customer.test", category: "onboarding", source: "list-unsubscribe" }, w.db);
    expect(await w.run(next)).toBe("exited");
    expect(await w.get()).toMatchObject({ status: "exited", stopReason: "unsubscribed", cursor: null, nextRunAt: null });
    expect(w.sent).toHaveLength(1);
  });

  it("without a marketing basis only the (service) welcome goes out; the rest waits for consent", async () => {
    const w = await world({ consent: "none" });
    const next = await throughWelcome(w);
    expect(await w.run(next)).toBe("held");
    let e = await w.get();
    expect(e.log.at(-1)).toMatchObject({ event: "waiting_for_consent" });
    expect(e.cursor).toEqual({ nodeId: "cond_1" }); // conditions are re-checked next time
    const retry = Date.parse(e.nextRunAt!);
    expect(retry).toBeGreaterThan(next + 12 * HOUR);

    await forTenant(system, w.db).productUsers.update(w.users[0]!.id, {
      consent: { basis: "consent", assertedBasis: "consent", source: "in_app", at: iso(next) },
    });
    expect(await w.run(retry)).toBe("sent");
    e = await w.get();
    expect(e.sentItems.map((s) => s.itemId)).toEqual(["w", "r1"]);
  });

  it("test mode only enrols listed test users", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const stranger = seedUser(db, "stranger");
    const { journey, version } = await publishOnboarding(db, { mode: "test", testUserIds: ["someone_else"] });
    const r = await enrolUser(system, { journey, version, user: stranger, source: "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 });
    expect(r).toEqual({ outcome: "skipped", reason: "not_a_test_recipient" });
  });

  it("the environment's mode ceiling holds a live journey's real users", async () => {
    const w = await world({ mode: "live", testUserIds: [] });
    delete process.env.LIFECYCLE_MODE_CEILING; // unset = test
    await w.run(T0);
    expect(await w.run(T0 + 15 * MIN)).toBe("held");
    const e = await w.get();
    expect(e.log.at(-1)).toMatchObject({ event: "mode_blocked" });
    expect(e.nextRunAt).toBe(iso(T0 + 45 * MIN));
    expect(w.sent).toHaveLength(0);
  });

  it("shadow mode mails the shadow inbox with a banner and no real unsubscribe token", async () => {
    const w = await world({ mode: "shadow", shadowInbox: "jez@sandbox.test", testUserIds: [] });
    await w.run(T0);
    expect(await w.run(T0 + 15 * MIN)).toBe("sent");
    const m = w.sent[0]!;
    expect(m.to).toBe("jez@sandbox.test");
    expect(m.html).toContain("Shadow mode");
    expect(m.html).toContain("alex@customer.test");
    expect(m.listUnsubscribe).toBeUndefined();
    expect(m.metadata).toBeUndefined();
    expect(m.html).not.toContain("/unsubscribe?u=");
    expect(await forTenant(system, w.db).emailEvents.find()).toHaveLength(0);
    expect((await w.get()).sentItems[0]).toMatchObject({ mode: "shadow", status: "sent" });
  });

  it("the daily cap is exact: the second user waits for tomorrow's window", async () => {
    const w = await world({ users: ["alex", "bea"], caps: { sendsPerDay: 1, enrolmentsPerDay: 10 } });
    const [alex, bea] = w.users;
    await w.run(T0, alex);
    await w.run(T0, bea);
    expect(await w.run(T0 + 15 * MIN, alex)).toBe("sent");
    expect(await w.run(T0 + 15 * MIN, bea)).toBe("held");
    const e = await w.get(bea);
    expect(e.log.at(-1)).toMatchObject({ event: "daily_cap" });
    expect(Date.parse(e.nextRunAt!)).toBeGreaterThanOrEqual(Date.parse("2026-09-22T08:00:00Z"));
    expect(w.sent).toHaveLength(1);
  });

  it("honours the product's exit and hold directives", async () => {
    const w = await world({ users: ["alex", "bea"] });
    const [alex, bea] = w.users;
    await w.run(T0, alex);
    await w.run(T0, bea);
    w.setContext(productContext({ exit: { reason: "staff account" } }));
    expect(await w.run(T0 + 15 * MIN, alex)).toBe("exited");
    expect((await w.get(alex)).stopReason).toBe("product_exit: staff account");
    w.setContext(productContext({ hold: { reason: "deletion pending" } }));
    expect(await w.run(T0 + 15 * MIN, bea)).toBe("held");
    expect((await w.get(bea)).nextRunAt).toBe(iso(T0 + 15 * MIN + 6 * HOUR));
    expect(w.sent).toHaveLength(0);
  });

  it("skips an item it can't fully render and sends the next eligible one", async () => {
    const w = await world();
    const draft = structuredClone(w.journey.draft);
    const welcome = draft.pools.find((p) => p.id === "welcome")!;
    welcome.items = [
      { ...welcome.items[0]!, id: "needs_fact", subject: "Your score: {{fact.missing_score}}" },
      { ...welcome.items[0]!, id: "plain" },
    ];
    expect((await saveLifecycleDraft(ctx, w.journey.id, draft, { db: w.db })).ok).toBe(true);
    const published = await publishLifecycleJourney(ctx, w.journey.id, { db: w.db });
    if (!published.ok) throw new Error(published.error);
    await forTenant(system, w.db).lifecycleJourneys.update(w.journey.id, { testRecipients: { userIds: ["alex", "cal"], emails: [] } });
    const journey = (await forTenant(system, w.db).lifecycleJourneys.getById(w.journey.id))!;
    const user = seedUser(w.db, "cal");
    const enrolled = await enrolUser(
      system,
      { journey, version: published.value.version, user, source: "manual", anchorAt: iso(T0) },
      { db: w.db, nowMs: T0 },
    );
    expect(enrolled.outcome).toBe("enrolled");

    await w.run(T0, user);
    expect(await w.run(T0 + 15 * MIN, user)).toBe("sent");
    expect(w.sent.at(-1)!.subject).toBe("Welcome to Sandbox, Alex");
    const e = await w.get(user);
    expect(e.sentItems.map((s) => s.itemId)).toEqual(["plain"]);
    expect(e.log.some((l) => l.event === "item_skipped" && l.detail?.startsWith("needs_fact"))).toBe(true);
  });

  it("a paused journey holds its enrolments; resuming picks them up again", async () => {
    const w = await world();
    await w.run(T0);
    await setLifecycleJourneyStatus(ctx, w.journey.id, "paused", { db: w.db });
    expect(await w.run(T0 + 15 * MIN)).toBe("held");
    expect((await w.get()).nextRunAt).toBe(iso(T0 + 45 * MIN));
    await setLifecycleJourneyStatus(ctx, w.journey.id, "active", { db: w.db });
    expect(await w.run(T0 + 45 * MIN)).toBe("sent"); // still inside the welcome's exemption
  });

  it("'run next step now' skips the wait for a test enrolment, but never for live", async () => {
    const w = await world();
    await throughWelcome(w);
    w.setNow(T0 + 30 * MIN);
    const r = await runEnrolmentNow(system, enrolmentDocId(w.journey.id, w.users[0]!.id), w.deps);
    expect(r).toEqual({ ok: true, outcome: "sent" });
    expect(w.sent.map((m) => m.subject)).toEqual(["Welcome to Sandbox, Alex", "Your next step: Add your brand"]);

    const live = await world({ mode: "live" });
    await live.run(T0);
    const denied = await runEnrolmentNow(system, enrolmentDocId(live.journey.id, live.users[0]!.id), live.deps);
    expect(denied).toEqual({ ok: false, error: "live" });
  });
});

describe("API v2 state in the runner", () => {
  const repo = (w: Awaited<ReturnType<typeof world>>) => forTenant(system, w.db);

  it("an excluded user leaves the journey without the product being asked", async () => {
    const w = await world();
    await repo(w).productUsers.update(w.users[0]!.id, { excluded: { reason: "staff", at: iso(T0) } });
    expect(await w.run(T0)).toBe("exited");
    expect(await w.get()).toMatchObject({ status: "exited", stopReason: "excluded: staff" });
    expect(w.contextCalls).toHaveLength(0);
  });

  it("the product's own opt-out (subscribed: false) ends the journey", async () => {
    const w = await world();
    await repo(w).productUsers.update(w.users[0]!.id, { subscribed: false });
    expect(await w.run(T0)).toBe("exited");
    expect((await w.get()).stopReason).toBe("unsubscribed_in_product");
  });

  it("with no context endpoint: no pull, stored steps and facts, and health isn't marked failing", async () => {
    const w = await world();
    await repo(w).productConnections.update(CONNECTION_ID, { contextEndpoint: null });
    await repo(w).productUsers.update(w.users[0]!.id, { facts: { share_of_voice: { value: 12, at: iso(T0) } } });
    await throughWelcome(w);
    expect(w.contextCalls).toHaveLength(0);
    const conn = await repo(w).productConnections.getById(CONNECTION_ID);
    expect(conn?.health?.consecutiveContextFailures ?? 0).toBe(0);
    expect(conn?.health?.lastContextError ?? null).toBeNull();
  });

  it("after 3 failed pulls in a row, skips pulling for 15 minutes and uses the stored state", async () => {
    const w = await world();
    await repo(w).productConnections.update(CONNECTION_ID, {
      health: { consecutiveContextFailures: 3, lastContextError: "timeout", lastContextErrorAt: iso(T0 + 10 * MIN) },
    });
    expect(await w.run(T0)).toBe("waiting");
    expect(await w.run(T0 + 15 * MIN)).toBe("sent");
    expect(w.contextCalls).toHaveLength(0);
    expect((await w.get()).log.some((l) => l.event === "context_skipped")).toBe(true);
  });
});

describe("consent at send (LIFECYCLE_CONSENT_AT_SEND)", () => {
  beforeEach(() => {
    process.env.LIFECYCLE_CONSENT_AT_SEND = "true";
  });
  afterEach(() => {
    delete process.env.LIFECYCLE_CONSENT_AT_SEND;
  });

  /** Keep running the enrolment until it sends (or stops, or 10 runs pass). */
  async function runUntilSent(w: Awaited<ReturnType<typeof world>>): Promise<string> {
    let last = "";
    for (let i = 0; i < 10; i += 1) {
      const e = await w.get();
      if (e.status !== "active" || !e.nextRunAt) break;
      last = await w.run(Date.parse(e.nextRunAt));
      if (last === "sent") break;
    }
    return last;
  }

  it("skips a marketing email that's due without consent, instead of holding it", async () => {
    const w = await world({ consent: "none" });
    const next = await throughWelcome(w);
    expect(await w.run(next)).not.toBe("held");
    const e = await w.get();
    expect(e.sentItems.map((s) => [s.itemId, s.status])).toEqual([
      ["w", "sent"],
      ["r1", "skipped"],
    ]);
    expect(e.sentItems[1]).toMatchObject({ reason: "no_marketing_consent" });
    expect(e.log.some((l) => l.event === "waiting_for_consent")).toBe(false);
    expect(w.sent).toHaveLength(1); // only the service welcome
  });

  it("sends later marketing emails once consent arrives, but never the skipped one", async () => {
    const w = await world({ consent: "none" });
    const next = await throughWelcome(w);
    await w.run(next);
    await forTenant(system, w.db).productUsers.update(w.users[0]!.id, {
      consent: { basis: "consent", assertedBasis: "consent", source: "in_app", at: iso(next) },
    });
    expect(await runUntilSent(w)).toBe("sent");
    const e = await w.get();
    expect(e.sentItems.filter((s) => s.itemId === "r1").map((s) => s.status)).toEqual(["skipped"]);
    expect(e.sentItems.at(-1)).toMatchObject({ status: "sent" });
    expect(e.sentItems.at(-1)!.itemId).not.toBe("r1");
    expect(w.sent).toHaveLength(2);
  });

  it("releases an enrolment the old rule held by skipping its email, not sending it late", async () => {
    delete process.env.LIFECYCLE_CONSENT_AT_SEND;
    const w = await world({ consent: "none" });
    const next = await throughWelcome(w);
    expect(await w.run(next)).toBe("held");
    process.env.LIFECYCLE_CONSENT_AT_SEND = "true";
    expect(await w.run(Date.parse((await w.get()).nextRunAt!))).not.toBe("held");
    expect((await w.get()).sentItems.find((s) => s.itemId === "r1")).toMatchObject({ status: "skipped", reason: "no_marketing_consent" });
    expect(w.sent).toHaveLength(1);
  });
});
