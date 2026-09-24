import { describe, it, expect } from "vitest";
import {
  activationAt,
  applyMessage,
  effectiveBasis,
  productEventDocId,
  productUserDocId,
  toUtcIso,
  TOMBSTONE_TTL_MS,
} from "./profile";
import type { IngestMessage } from "./protocol";
import type { ProductUser } from "@/lib/types/productUser";

const connection = {
  id: "pcn_1",
  consentPolicy: {
    marketingBases: ["consent", "soft_opt_in", "corporate_subscriber"] as const,
    verifyCorporateDomain: true,
  },
} as unknown as Parameters<typeof applyMessage>[2]["connection"];
const NOW = Date.parse("2026-09-21T12:00:00Z");

function identify(ts: string, traits: Record<string, unknown>, extra: Partial<IngestMessage> = {}): IngestMessage {
  return { type: "identify", messageId: `m-${ts}`, userId: "u1", timestamp: ts, traits, ...extra } as IngestMessage;
}
function track(ts: string, event: string, properties: Record<string, unknown> = {}): IngestMessage {
  return { type: "track", messageId: `t-${ts}-${event}`, userId: "u1", timestamp: ts, event, properties } as IngestMessage;
}

/** Apply a sequence of messages, like the ingest transaction would. */
function run(msgs: IngestMessage[], start: ProductUser | null = null): ProductUser | null {
  let cur = start;
  for (const m of msgs) {
    const r = applyMessage(cur, m, { connection, nowMs: NOW });
    if ("reject" in r) throw new Error(r.reject);
    if (r.next) cur = { id: "pu_1", tenantId: "ten_A", ...r.next } as ProductUser;
  }
  return cur;
}

describe("applyMessage", () => {
  it("maps reserved identity traits and keeps custom ones", () => {
    const u = run([
      identify("2026-09-21T10:00:00.000Z", {
        email: " Alex@Acme.test ",
        first_name: "Alex",
        timezone: "Europe/London",
        locale: "en-GB",
        plan: "pro",
      }),
    ])!;
    expect(u).toMatchObject({
      email: "Alex@Acme.test",
      emailNormalized: "alex@acme.test",
      firstName: "Alex",
      timezone: "Europe/London",
      locale: "en-GB",
      traits: { plan: "pro" },
      status: "active",
    });
  });

  it("is last-write-wins by EVENT time: an older identify changes nothing", () => {
    const newer = run([identify("2026-09-21T10:00:00.000Z", { plan: "pro" })])!;
    const r = applyMessage(newer, identify("2026-09-21T09:00:00.000Z", { plan: "free" }), { connection, nowMs: NOW });
    expect(r).toEqual({ next: null, applied: false });
  });

  it("deletes a custom trait sent as null", () => {
    const u = run([
      identify("2026-09-21T10:00:00.000Z", { plan: "pro", beta: true }),
      identify("2026-09-21T11:00:00.000Z", { beta: null }),
    ])!;
    expect(u.traits).toEqual({ plan: "pro" });
  });

  it("rejects an invalid email, timezone or locale", () => {
    for (const [traits, reason] of [
      [{ email: "not-an-email" }, "invalid_email"],
      [{ timezone: "Mars/Olympus" }, "invalid_timezone"],
      [{ locale: "english please" }, "invalid_locale"],
      [{ email: 42 }, "invalid_email"],
    ] as const) {
      expect(applyMessage(null, identify("2026-09-21T10:00:00.000Z", traits), { connection, nowMs: NOW })).toEqual({
        reject: reason,
      });
    }
  });

  it("keeps a step's EARLIEST completion time and counts milestones", () => {
    const u = run([
      track("2026-09-21T10:00:00.000Z", "onboarding.step_completed", { step: "create_brand" }),
      track("2026-09-21T08:00:00.000Z", "onboarding.step_completed", { step: "create_brand" }),
      track("2026-09-21T11:00:00.000Z", "onboarding.step_completed", { step: "first_audit" }),
    ])!;
    expect(u.steps).toEqual({
      create_brand: { doneAt: "2026-09-21T08:00:00.000Z" },
      first_audit: { doneAt: "2026-09-21T11:00:00.000Z" },
    });
    expect(u.milestones["onboarding.step_completed"]).toEqual({
      firstAt: "2026-09-21T08:00:00.000Z",
      lastAt: "2026-09-21T11:00:00.000Z",
      count: 3,
    });
    expect(u.firstSeenAt).toBe("2026-09-21T08:00:00.000Z");
  });

  it("rejects a step event without a valid step id", () => {
    const r = applyMessage(null, track("2026-09-21T10:00:00.000Z", "onboarding.step_completed", {}), {
      connection,
      nowMs: NOW,
    });
    expect(r).toEqual({ reject: "invalid_step" });
  });

  it("records email preferences last-write-wins", () => {
    const u = run([
      track("2026-09-21T10:00:00.000Z", "email_preferences.updated", { category: "onboarding", subscribed: false }),
      track("2026-09-21T09:00:00.000Z", "email_preferences.updated", { category: "onboarding", subscribed: true }),
    ])!;
    expect(u.emailPreferences.onboarding).toEqual({ subscribed: false, at: "2026-09-21T10:00:00.000Z" });
  });

  it("downgrades corporate_subscriber on a free-mail address, and re-derives if the email changes", () => {
    const gmail = run([
      identify(
        "2026-09-21T10:00:00.000Z",
        { email: "alex@gmail.com" },
        { consent: { basis: "corporate_subscriber" } } as Partial<IngestMessage>,
      ),
    ])!;
    expect(gmail.consent).toMatchObject({ basis: "none", assertedBasis: "corporate_subscriber" });

    const moved = run([identify("2026-09-21T11:00:00.000Z", { email: "alex@acme.co.uk" })], gmail)!;
    expect(moved.consent).toMatchObject({ basis: "corporate_subscriber" });
  });

  it("leaves other bases alone and honours the policy switch", () => {
    expect(effectiveBasis("consent", "a@gmail.com", connection)).toBe("consent");
    expect(
      effectiveBasis("corporate_subscriber", "a@gmail.com", {
        consentPolicy: { marketingBases: [], verifyCorporateDomain: false },
      }),
    ).toBe("corporate_subscriber");
    expect(effectiveBasis("corporate_subscriber", null, connection)).toBe("none");
  });

  it("tombstones on user.deleted: PII gone, ttl set, later messages refused", () => {
    const u = run([identify("2026-09-21T10:00:00.000Z", { email: "a@acme.test", plan: "pro" })])!;
    const del = applyMessage(u, track("2026-09-21T11:00:00.000Z", "user.deleted"), { connection, nowMs: NOW });
    expect("next" in del && del.next).toMatchObject({
      status: "deleted",
      email: null,
      emailNormalized: null,
      traits: {},
      ttlAt: new Date(NOW + TOMBSTONE_TTL_MS),
    });
    const tomb = { id: "pu_1", tenantId: "ten_A", ...(del as { next: object }).next } as ProductUser;
    expect(applyMessage(tomb, identify("2026-09-21T12:00:00.000Z", { plan: "x" }), { connection, nowMs: NOW })).toEqual(
      { reject: "user_deleted" },
    );
    // Deleting twice (or a never-seen user) is a quiet no-op.
    expect(applyMessage(tomb, track("2026-09-21T12:00:00.000Z", "user.deleted"), { connection, nowMs: NOW })).toEqual({
      next: null,
      applied: false,
    });
    expect(applyMessage(null, track("2026-09-21T12:00:00.000Z", "user.deleted"), { connection, nowMs: NOW })).toEqual({
      next: null,
      applied: false,
    });
  });
});

describe("ids and time", () => {
  it("derives stable, connection-scoped ids", () => {
    expect(productUserDocId("pcn_1", "u1")).toBe(productUserDocId("pcn_1", "u1"));
    expect(productUserDocId("pcn_1", "u1")).not.toBe(productUserDocId("pcn_2", "u1"));
    expect(productUserDocId("pcn_1", "u1")).toMatch(/^pu_[0-9a-f]{32}$/);
    expect(productEventDocId("pcn_1", "m1")).toMatch(/^pe_[0-9a-f]{32}$/);
  });

  it("normalises offsets to UTC so string order is time order", () => {
    expect(toUtcIso("2026-09-21T10:00:00+01:00")).toBe("2026-09-21T09:00:00.000Z");
  });
});

describe("activation", () => {
  const withSteps = {
    ...(connection as object),
    catalog: { onboardingSteps: [{ id: "connect_site" }, { id: "first_report" }] },
  } as unknown as Parameters<typeof applyMessage>[2]["connection"];

  function runWith(conn: typeof withSteps, msgs: IngestMessage[]): ProductUser | null {
    let cur: ProductUser | null = null;
    for (const m of msgs) {
      const r = applyMessage(cur, m, { connection: conn, nowMs: NOW });
      if ("reject" in r) throw new Error(r.reject);
      if (r.next) cur = { id: "pu_1", tenantId: "ten_A", ...r.next } as ProductUser;
    }
    return cur;
  }

  it("activates at the first onboarding.completed and never un-activates", () => {
    const u = run([
      identify("2026-09-21T09:00:00.000Z", { email: "a@acme.test" }),
      track("2026-09-21T10:00:00.000Z", "onboarding.completed"),
      track("2026-09-21T11:00:00.000Z", "onboarding.completed"),
    ])!;
    expect(u.activated).toBe(true);
    expect(u.activatedAt).toBe("2026-09-21T10:00:00.000Z");
  });

  it("activates when every catalog step is done, at the last step's time", () => {
    const step = (ts: string, id: string) => track(ts, "onboarding.step_completed", { step: id });
    const half = runWith(withSteps, [step("2026-09-21T09:00:00.000Z", "connect_site")])!;
    expect(half.activated).toBeUndefined();
    const all = runWith(withSteps, [
      step("2026-09-21T09:00:00.000Z", "connect_site"),
      step("2026-09-21T10:30:00.000Z", "first_report"),
    ])!;
    expect(all).toMatchObject({ activated: true, activatedAt: "2026-09-21T10:30:00.000Z" });
  });

  it("needs a catalog step list for the steps rule, and takes the earlier of the two rules", () => {
    const steps = { connect_site: { doneAt: "2026-09-21T10:00:00.000Z" } };
    expect(activationAt({ steps, milestones: {} }, [])).toBeNull();
    expect(
      activationAt(
        { steps, milestones: { "onboarding.completed": { firstAt: "2026-09-21T08:00:00.000Z", lastAt: "x", count: 1 } } },
        [{ id: "connect_site" }],
      ),
    ).toBe("2026-09-21T08:00:00.000Z");
  });

  it("a tombstone clears activation", () => {
    const u = run([track("2026-09-21T10:00:00.000Z", "onboarding.completed")])!;
    const del = applyMessage(u, track("2026-09-21T11:00:00.000Z", "user.deleted"), { connection, nowMs: NOW });
    expect("next" in del && del.next).toMatchObject({ status: "deleted", activated: false, activatedAt: null });
  });
});

