import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { EmailMessage, EmailResult } from "@/lib/email";
import type { Signup } from "@/lib/types/signup";
import type { JourneyGraph, JourneyNode } from "@/lib/types/journey";
import { enrollSignupInActiveJourney, processEmailJobs } from "@/lib/email/delivery";
import { convertLegacyJourney } from "./convert";
import { enrolWaitlistSignup } from "./enrol";
import { drainWaitlistTenant } from "./runner";
import { CAMPAIGN_ID, publishWaitlist, seedLaunch, seedSignup, system, T0, TENANT_ID } from "./testing/fixtures";

/**
 * The GOLDEN PARITY SUITE (engine move D3): the same journeys, for the same
 * people, run through the original engine and — converted — through the
 * lifecycle engine, on a simulated clock. Every email must match: the step, the
 * A/B arm, the subject, the body, the sender and the send time (within one tick
 * of the 2-minute scheduler), and the weekly-newsletter hand-offs too. People are
 * synthetic, on example.test.
 */

type Sent = { engine: "legacy" | "lifecycle"; at: number; msg: EmailMessage };
const outbox: Sent[] = [];
const weekly: Array<{ engine: "legacy" | "lifecycle"; at: number; signupId: string }> = [];
let engine: "legacy" | "lifecycle" = "legacy";

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: vi.fn(async (msg: EmailMessage): Promise<EmailResult> => {
      outbox.push({ engine, at: Date.now(), msg });
      return { sent: true, provider: "mandrill", id: `m_${outbox.length}` };
    }),
  };
});
vi.mock("@/lib/mailchimp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mailchimp")>();
  return {
    ...actual,
    syncSignupToWeekly: vi.fn(async (_ctx: unknown, _campaign: unknown, signup: { id: string }) => {
      weekly.push({ engine, at: Date.now(), signupId: signup.id });
      return { ok: true };
    }),
  };
});

const H = 3600_000;
const TICK = 2 * 60_000;
const HORIZON = T0 + 40 * 24 * H;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://mk.test");
  outbox.length = 0;
  weekly.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---- The people ------------------------------------------------------------------------------

const voice = { completed: true, transcript: [], capturedAt: new Date(T0).toISOString(), bonusApplied: false };
const PEOPLE: Array<[string, Partial<Signup>]> = [
  ["ada", {}],
  ["grace", { amountReferred: 3, utm: { source: "linkedin-ads" } } as Partial<Signup>],
  ["lin", { aiConversation: voice, answers: [{ question_value: "role", optional: false, answer_value: "founder" }] }],
  ["noor", { amountReferred: 5, aiConversation: voice }],
  ["omar", { firstName: undefined, aiConversation: voice }],
  ["priya", { metadata: { company: "Acme" }, aiConversation: voice, referralLink: "https://fernlight.example.test/r/priya" } as Partial<Signup>],
];

function seedPeople(db: FakeFirestore): Signup[] {
  return PEOPLE.map(([id, over], i) =>
    seedSignup(db, id, { createdAt: new Date(T0 - (PEOPLE.length - i) * 60_000).toISOString(), ...over }),
  );
}

// ---- The journeys ----------------------------------------------------------------------------

const at = { x: 0, y: 0 };
const node = (id: string, type: JourneyNode["type"], data: JourneyNode["data"] = {}): JourneyNode => ({ id, type, position: at, data });
const edge = (source: string, target: string, sourceHandle: string | null = null) => ({ id: `${source}-${target}-${sourceHandle ?? ""}`, source, target, sourceHandle });
const BODY =
  "<p>Hi {{first_name}}, you're #{{current_rank}} on the {{waitlist_name}} list with {{referral_count}} referrals.</p>" +
  "<p>From {{metadata.company}}? Share {{referral_link}}.</p>";

/** Timing, merge tags, a hero image and a running A/B test. */
const TIMING: JourneyGraph = {
  nodes: [
    node("trigger", "trigger"),
    node("email_welcome", "email", {
      subject: "Welcome to {{waitlist_name}}, {{first_name}}",
      body: BODY,
      heroImageUrl: "https://cdn.example.test/hero.png",
      abTest: {
        enabled: true,
        status: "running",
        splitPercent: 50,
        variants: [{ variantId: "var_2c5e3a7e-0d7b-4f0e-9a51-9b0f6c1d2e3f", subject: "You're in, {{first_name}}", body: "<p>Rank #{{current_rank}}.</p>", heroImageUrl: null }],
      },
    }),
    node("wait_a", "wait", { waitHours: 24 }),
    node("wait_b", "wait", { waitHours: 24 }),
    node("email_second", "email", { subject: "Two days in", body: "Plain text for {{first_name}}.\n\nSecond paragraph." }),
    node("wait_c", "wait", { waitHours: 72 }),
    node("exit", "exit"),
  ],
  edges: [
    edge("trigger", "email_welcome"),
    edge("email_welcome", "wait_a"),
    edge("wait_a", "wait_b"),
    edge("wait_b", "email_second"),
    edge("email_second", "wait_c"),
    edge("wait_c", "exit"),
  ],
};

/** Conditions on every kind of signup field, an unwired branch, waits after branches and weekly exits. */
const BRANCHING: JourneyGraph = {
  nodes: [
    node("trigger", "trigger"),
    node("email_hi", "email", { subject: "Hello {{first_name}}", body: BODY }),
    node("wait_1", "wait", { waitHours: 12 }),
    node("cond", "condition", {
      branches: [
        { id: "br_ref", match: "all", conditions: [{ field: "referralCount", operator: "gte", value: 2 }, { field: "utmSource", operator: "contains", value: "linkedin" }] },
        { id: "br_voice", conditions: [{ field: "usedVoiceChat", operator: "is_false" }] },
        { id: "br_survey", condition: { field: "surveyAnswer", operator: "eq", value: "founder", questionValue: "role" } },
        { id: "br_rank", conditions: [{ field: "rank", operator: "lte", value: 2 }] },
      ],
    }),
    node("email_ref", "email", { subject: "Thanks for sharing", body: "<p>{{referral_count}} friends joined.</p>" }),
    node("wait_voice", "wait", { waitHours: 6 }),
    node("email_voice", "email", { subject: "Try the voice chat", body: "It takes a minute." }),
    node("email_survey", "email", { subject: "For founders", body: "Founder notes." }),
    node("email_else", "email", { subject: "What's next", body: "<p>Rank #{{current_rank}}</p>" }),
    node("wait_week", "wait", { waitHours: 24 }),
    node("weekly", "exit", { exitTargetKind: "weekly" }),
    node("end", "exit"),
  ],
  edges: [
    edge("trigger", "email_hi"),
    edge("email_hi", "wait_1"),
    edge("wait_1", "cond"),
    edge("cond", "email_ref", "br_ref"),
    edge("cond", "wait_voice", "br_voice"),
    edge("cond", "email_survey", "br_survey"),
    edge("cond", "email_else", "default"),
    edge("email_ref", "wait_week"),
    edge("wait_week", "weekly"),
    edge("wait_voice", "email_voice"),
    edge("email_voice", "end"),
    edge("email_else", "weekly"),
  ],
};

/** A decided A/B test, back-to-back emails and a sequence hand-off. */
const PROMOTED: JourneyGraph = {
  nodes: [
    node("trigger", "trigger"),
    node("email_1", "email", {
      subject: "The winner",
      body: "Winning copy",
      abTest: { enabled: false, status: "promoted", splitPercent: 50, winnerVariantId: "var_x", variants: [{ variantId: "var_x", subject: "The winner", body: "Winning copy" }] },
    }),
    node("email_2", "email", { subject: "Straight after", body: "No wait." }),
    node("wait_1", "wait", { waitHours: 1 }),
    node("email_3", "email", { subject: "An hour later", body: "Last one." }),
    node("handoff", "exit", { exitTargetKind: "sequence" }),
  ],
  edges: [edge("trigger", "email_1"), edge("email_1", "email_2"), edge("email_2", "wait_1"), edge("wait_1", "email_3"), edge("email_3", "handoff")],
};

// ---- Running each engine ---------------------------------------------------------------------

async function runOriginal(graph: JourneyGraph): Promise<void> {
  engine = "legacy";
  const db = new FakeFirestore();
  seedLaunch(db);
  const people = seedPeople(db);
  db.seed("journeys", `journey_${CAMPAIGN_ID}`, { tenantId: TENANT_ID, campaignId: CAMPAIGN_ID, status: "active", graph, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() });
  vi.setSystemTime(T0);
  for (const p of people) expect(await enrollSignupInActiveJourney(system, CAMPAIGN_ID, p, db)).toBe("enqueued");
  let now = T0;
  for (let i = 0; i < 500; i += 1) {
    const pending = (await forTenant(system, db).emailJobs.find({ where: [["status", "==", "pending"]] })).map((j) => Date.parse(j.scheduledAt));
    if (pending.length === 0) break;
    now = Math.max(now, Math.min(...pending));
    if (now > HORIZON) break;
    vi.setSystemTime(now);
    await processEmailJobs(system, 100, db);
  }
  const failed = await forTenant(system, db).emailJobs.find({ where: [["status", "==", "failed"]] });
  expect(failed).toEqual([]);
}

async function runLifecycle(graph: JourneyGraph): Promise<void> {
  engine = "lifecycle";
  const db = new FakeFirestore();
  seedLaunch(db);
  const people = seedPeople(db);
  const { draft, report } = convertLegacyJourney({ graph });
  expect(report.blocking).toEqual([]);
  vi.setSystemTime(T0 - H);
  const { journey, version } = await publishWaitlist(db, { draft: draft! });
  const campaign = (await forTenant(system, db).campaigns.getById(CAMPAIGN_ID))!;
  vi.setSystemTime(T0);
  for (const signup of people) {
    const r = await enrolWaitlistSignup(system, { journey, version, campaign, signup, source: "trigger" }, { db, nowMs: T0 });
    expect(r.outcome).toBe("enrolled");
  }
  let now = T0;
  for (let i = 0; i < 500; i += 1) {
    const due = (await forTenant(system, db).waitlistEnrolments.find({ where: [["status", "==", "active"]] }))
      .map((e) => (e.nextRunAt ? Date.parse(e.nextRunAt) : Infinity))
      .filter(Number.isFinite);
    if (due.length === 0) break;
    now = Math.max(now, Math.min(...due));
    if (now > HORIZON) break;
    vi.setSystemTime(now);
    await drainWaitlistTenant(system, { db, now: () => Date.now() });
  }
  const stuck = await forTenant(system, db).waitlistEnrolments.find({ where: [["status", "==", "active"]] });
  expect(stuck).toEqual([]);
}

/** What must match between the engines, per email (tokens carry a timestamp, so they're masked). */
function comparable(s: Sent) {
  const mask = (x: string | undefined) => (x ?? "").replace(/u=[A-Za-z0-9._%-]+/g, "u=<token>");
  const m = s.msg;
  return {
    to: m.to,
    nodeId: m.metadata?.nodeId,
    variantId: m.metadata?.variantId,
    signupId: m.metadata?.signupId,
    campaignId: m.metadata?.campaignId,
    subject: m.subject,
    html: mask(m.html),
    text: mask(m.text),
    from: [m.fromEmail, m.fromName, m.replyTo],
    track: m.track,
    tags: m.tags,
    oneClickUnsubscribe: Boolean(m.listUnsubscribe?.url),
  };
}

async function expectParity(graph: JourneyGraph): Promise<{ emails: number }> {
  await runOriginal(graph);
  await runLifecycle(graph);
  const byPerson = (e: Sent["engine"]) => {
    const map = new Map<string, Sent[]>();
    for (const s of outbox.filter((x) => x.engine === e)) map.set(s.msg.to, [...(map.get(s.msg.to) ?? []), s]);
    return map;
  };
  const legacy = byPerson("legacy");
  const lifecycle = byPerson("lifecycle");
  expect([...lifecycle.keys()].sort()).toEqual([...legacy.keys()].sort());
  for (const [to, sends] of legacy) {
    const other = lifecycle.get(to)!;
    expect(other.map(comparable)).toEqual(sends.map(comparable));
    sends.forEach((s, i) => expect(Math.abs(other[i]!.at - s.at)).toBeLessThanOrEqual(TICK));
  }
  const hand = (e: Sent["engine"]) => weekly.filter((w) => w.engine === e).map((w) => w.signupId).sort();
  expect(hand("lifecycle")).toEqual(hand("legacy"));
  for (const w of weekly.filter((x) => x.engine === "legacy")) {
    const twin = weekly.find((x) => x.engine === "lifecycle" && x.signupId === w.signupId)!;
    expect(Math.abs(twin.at - w.at)).toBeLessThanOrEqual(TICK);
  }
  return { emails: outbox.filter((x) => x.engine === "legacy").length };
}

describe("golden parity: the original engine and the lifecycle engine send the same emails", () => {
  it("timing, merge tags, a hero image and A/B arms", async () => {
    const { emails } = await expectParity(TIMING);
    expect(emails).toBe(PEOPLE.length * 2);
    const arms = new Set(outbox.filter((s) => s.msg.metadata?.nodeId === "email_welcome").map((s) => s.msg.metadata?.variantId));
    expect(arms.size).toBe(2); // both arms were exercised
  });

  it("conditions on signup fields, an unwired branch, waits after branches and weekly exits", async () => {
    const { emails } = await expectParity(BRANCHING);
    expect(emails).toBeGreaterThan(PEOPLE.length);
    expect(weekly.filter((w) => w.engine === "legacy").length).toBeGreaterThan(0);
    // noor matches only the unwired branch: the welcome, then nothing more, on both engines.
    expect(outbox.filter((s) => s.msg.to === "noor@example.test").map((s) => s.msg.subject)).toEqual(["Hello Noor", "Hello Noor"]);
  });

  it("a decided A/B test, back-to-back emails and a sequence hand-off", async () => {
    const { emails } = await expectParity(PROMOTED);
    expect(emails).toBe(PEOPLE.length * 3);
  });
});
