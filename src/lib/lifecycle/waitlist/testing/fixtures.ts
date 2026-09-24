import type { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { LifecycleDraft, LifecycleJourney, LifecycleVersion } from "@/lib/types/lifecycle";
import type { Signup } from "@/lib/types/signup";
import { createWaitlistJourney, publishLifecycleJourney, updateLifecycleDelivery, waitlistSettings } from "../../service";
import { ctx, seedWorld, T0, TENANT_ID } from "../../testing/fixtures";

/**
 * Test fixtures for waitlist journeys on the lifecycle engine: the lifecycle
 * test tenant (verified sending domain), one launch and its signups. Every
 * address is on example.test.
 */

export { ctx, system, T0, TENANT_ID } from "../../testing/fixtures";
export const CAMPAIGN_ID = "camp1";
const ISO0 = new Date(T0).toISOString();

export function seedLaunch(db: FakeFirestore, over: Record<string, unknown> = {}): void {
  seedWorld(db);
  db.seed("campaigns", CAMPAIGN_ID, {
    tenantId: TENANT_ID,
    waitlistName: "Fernlight",
    productName: "Fernlight",
    archivedAt: null,
    createdAt: ISO0,
    updatedAt: ISO0,
    ...over,
  });
}

export function seedSignup(db: FakeFirestore, id: string, over: Partial<Omit<Signup, "id" | "tenantId">> = {}): Signup {
  const doc = {
    tenantId: TENANT_ID,
    campaignId: CAMPAIGN_ID,
    email: `${id}@example.test`,
    firstName: id.charAt(0).toUpperCase() + id.slice(1),
    status: "verified_active" as const,
    verified: true,
    amountReferred: 0,
    score: 0,
    createdAt: ISO0,
    ...over,
  };
  db.seed("signups", id, doc);
  return { id, ...doc } as unknown as Signup;
}

const at = (x: number, y: number) => ({ x, y });

/**
 * trigger → Welcome → wait 24 h (from the previous step) → "used the voice
 * chat?" → no: "Try the voice chat" / default: "Thanks for chatting" → end.
 */
export function welcomeDraft(over: { exitTarget?: "weekly"; abTest?: { splitPercent: number } } = {}): LifecycleDraft {
  return {
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", position: at(0, 0), data: { label: "Joined" } },
        { id: "email1", type: "email", position: at(0, 100), data: { label: "Welcome", poolId: "p_email1" } },
        { id: "wait1", type: "wait", position: at(0, 200), data: { wait: { minHours: 24, after: "previous_step" } } },
        {
          id: "cond1",
          type: "condition",
          position: at(0, 300),
          data: { branches: [{ id: "br_no_voice", conditions: [{ field: "signup.usedVoiceChat", operator: "is_false" }] }] },
        },
        { id: "email2", type: "email", position: at(-100, 400), data: { label: "Nudge", poolId: "p_email2" } },
        { id: "email3", type: "email", position: at(100, 400), data: { label: "Thanks", poolId: "p_email3" } },
        { id: "exit", type: "exit", position: at(0, 500), data: over.exitTarget ? { exitTarget: over.exitTarget } : {} },
      ],
      edges: [
        { id: "e0", source: "trigger", target: "email1", sourceHandle: null },
        { id: "e1", source: "email1", target: "wait1", sourceHandle: null },
        { id: "e2", source: "wait1", target: "cond1", sourceHandle: null },
        { id: "e3", source: "cond1", target: "email2", sourceHandle: "br_no_voice" },
        { id: "e4", source: "cond1", target: "email3", sourceHandle: "default" },
        { id: "e5", source: "email2", target: "exit", sourceHandle: null },
        { id: "e6", source: "email3", target: "exit", sourceHandle: null },
      ],
    },
    pools: [
      {
        id: "p_email1",
        label: "Welcome",
        items: [
          { id: "control", label: "Welcome", subject: "Welcome to {{waitlist_name}}", body: "Hi {{first_name}}, you're #{{current_rank}}.", heroImageUrl: "https://cdn.example.test/hero.png", format: "branded", messageClass: "marketing", personalization: "none" },
          ...(over.abTest
            ? [{ id: "var_b", label: "Variant B", subject: "You're in, {{first_name}}", body: "Welcome aboard.", format: "branded" as const, messageClass: "marketing" as const, personalization: "none" as const }]
            : []),
        ],
        ...(over.abTest ? { abTest: over.abTest } : {}),
      },
      { id: "p_email2", label: "Nudge", items: [{ id: "control", label: "Nudge", subject: "Try the voice chat", body: "It takes a minute.", format: "branded", messageClass: "marketing", personalization: "none" }] },
      { id: "p_email3", label: "Thanks", items: [{ id: "control", label: "Thanks", subject: "Thanks for chatting", body: "Good to hear from you.", format: "branded", messageClass: "marketing", personalization: "none" }] },
    ],
    settings: waitlistSettings(),
  };
}

/** Create and publish the launch's waitlist journey (live unless told otherwise). */
export async function publishWaitlist(
  db: FakeFirestore,
  opts: {
    draft?: LifecycleDraft;
    mode?: "test" | "shadow" | "live";
    testEmails?: string[];
    shadowInbox?: string | null;
    caps?: { sendsPerDay: number; enrolmentsPerDay: number };
    nowMs?: number;
  } = {},
): Promise<{ journey: LifecycleJourney; version: LifecycleVersion }> {
  const nowMs = opts.nowMs ?? T0 - 3600_000;
  const created = await createWaitlistJourney(ctx, { campaignId: CAMPAIGN_ID, draft: opts.draft ?? welcomeDraft() }, { db, nowMs });
  if (!created.ok) throw new Error(`create failed: ${created.error}`);
  const id = created.value.journey.id;
  if (opts.mode || opts.testEmails || opts.shadowInbox !== undefined || opts.caps) {
    const delivery = await updateLifecycleDelivery(
      ctx,
      id,
      {
        ...(opts.mode ? { deliveryMode: opts.mode } : {}),
        ...(opts.testEmails ? { testRecipients: { userIds: [], emails: opts.testEmails } } : {}),
        ...(opts.shadowInbox !== undefined ? { shadowInbox: opts.shadowInbox } : {}),
        ...(opts.caps ? { caps: opts.caps } : {}),
      },
      { db, nowMs },
    );
    if (!delivery.ok) throw new Error(`delivery failed: ${delivery.error}`);
  }
  const published = await publishLifecycleJourney(ctx, id, { db, nowMs });
  if (!published.ok) throw new Error(`publish failed: ${published.error} ${JSON.stringify(published.detail)}`);
  return { journey: published.value.journey, version: published.value.version };
}
