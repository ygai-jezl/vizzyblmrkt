import type { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { ProductContext } from "@/lib/connect/protocol";
import type { ContextResult } from "@/lib/connect/contextClient";
import type { EmailMessage, EmailResult } from "@/lib/email";
import type { DeliveryMode, LifecycleJourney, LifecycleVersion } from "@/lib/types/lifecycle";
import type { ProductUser } from "@/lib/types/productUser";
import { productUserDocId } from "@/lib/connect/profile";
import { createLifecycleJourney, publishLifecycleJourney, updateLifecycleDelivery } from "../service";

/**
 * Test fixtures for the lifecycle runtime: one tenant with a verified sending
 * domain, one connected product with a three-step onboarding checklist, and
 * product users. Everything lives in a FakeFirestore.
 */

export const TENANT_ID = "ten_life";
export const CONNECTION_ID = "pcn_life";
export const ctx: TenantContext = {
  tenantId: TENANT_ID,
  region: "eu",
  source: "idtoken",
  role: "admin",
  email: "jez@sandbox.test",
  userId: "usr_1",
};
export const system: TenantContext = { tenantId: TENANT_ID, region: "eu", source: "system" };

/** Monday 21 Sep 2026, 08:00 in London (BST). */
export const T0 = Date.parse("2026-09-21T07:00:00Z");
const ISO0 = new Date(T0).toISOString();

export const STEPS = [
  { id: "create_brand", label: "Add your brand", url: "https://app.example.com/brand", order: 0 },
  { id: "run_audit", label: "Run an audit", url: "https://app.example.com/audits?new=1", order: 1 },
  { id: "monitor_prompts", label: "Monitor prompts", url: "https://app.example.com/prompts", order: 2 },
];

export function seedWorld(db: FakeFirestore): void {
  db.seed("tenants", TENANT_ID, {
    tenantName: "Sandbox Co",
    rootDomain: "sandbox.test",
    status: "active",
    region: "eu",
    allowedOrigins: [],
    billingTier: "pro",
    ownerId: "usr_1",
    createdAt: ISO0,
    updatedAt: ISO0,
    emailSenderConfig: {
      senderName: "Jez at Sandbox",
      fromLocalPart: "jez",
      fromDomain: "sandbox.test",
      replyTo: "jez@sandbox.test",
      postalAddress: "1 High Street, London",
      privacyPolicyUrl: "https://sandbox.test/privacy",
      domains: [{ domain: "sandbox.test", status: "verified", addedAt: ISO0 }],
    },
  });
  db.seed("product_connections", CONNECTION_ID, {
    tenantId: TENANT_ID,
    name: "Sandbox",
    kind: "custom",
    status: "active",
    keyId: "ygk_test",
    secretEnc: null,
    secretPrefix: "ygs_x",
    contextEndpoint: null,
    webhookEndpoint: null,
    linkDomains: ["example.com"],
    catalog: { events: [], traits: [{ key: "plan", type: "string", label: "Plan", description: "" }], onboardingSteps: STEPS, glossary: [] },
    consentPolicy: { marketingBases: ["consent", "soft_opt_in", "corporate_subscriber"], verifyCorporateDomain: true },
    defaults: { timezone: "Europe/London", locale: "en" },
    health: {},
    sandbox: null,
    createdAt: ISO0,
    updatedAt: ISO0,
  });
}

export function seedUser(
  db: FakeFirestore,
  externalUserId: string,
  over: Partial<Omit<ProductUser, "id" | "tenantId">> = {},
): ProductUser {
  const id = productUserDocId(CONNECTION_ID, externalUserId);
  const doc = {
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    externalUserId,
    email: `${externalUserId}@customer.test`,
    emailNormalized: `${externalUserId}@customer.test`,
    firstName: "Alex",
    lastName: null,
    timezone: "Europe/London",
    locale: "en",
    traits: { plan: "free" },
    traitsUpdatedAt: ISO0,
    steps: {},
    milestones: { "user.signed_up": { firstAt: ISO0, lastAt: ISO0, count: 1 } },
    consent: { basis: "consent" as const, assertedBasis: "consent" as const, source: "signup", at: ISO0 },
    emailPreferences: {},
    status: "active" as const,
    firstSeenAt: ISO0,
    lastSeenAt: ISO0,
    createdAt: ISO0,
    updatedAt: ISO0,
    ...over,
  };
  db.seed("product_users", id, doc);
  return { id, ...doc } as ProductUser;
}

/** Create + publish the onboarding template in the given delivery mode. */
export async function publishOnboarding(
  db: FakeFirestore,
  opts: {
    mode?: DeliveryMode;
    testUserIds?: string[];
    shadowInbox?: string | null;
    caps?: { sendsPerDay: number; enrolmentsPerDay: number };
    nowMs?: number;
  } = {},
): Promise<{ journey: LifecycleJourney; version: LifecycleVersion }> {
  const nowMs = opts.nowMs ?? T0 - 3600_000;
  const created = await createLifecycleJourney(
    ctx,
    { name: "Onboarding", connectionId: CONNECTION_ID, template: "product_onboarding" },
    { db, nowMs },
  );
  if (!created.ok) throw new Error(`create failed: ${created.error}`);
  const id = created.value.journey.id;
  const delivery = await updateLifecycleDelivery(
    ctx,
    id,
    {
      deliveryMode: opts.mode ?? "test",
      testRecipients: { userIds: opts.testUserIds ?? [], emails: [] },
      ...(opts.shadowInbox !== undefined ? { shadowInbox: opts.shadowInbox } : {}),
      ...(opts.caps ? { caps: opts.caps } : {}),
    },
    { db, nowMs },
  );
  if (!delivery.ok) throw new Error(`delivery failed: ${delivery.error}`);
  const published = await publishLifecycleJourney(ctx, id, { db, nowMs });
  if (!published.ok) throw new Error(`publish failed: ${published.error} ${JSON.stringify(published.detail)}`);
  return { journey: published.value.journey, version: published.value.version };
}

/** A product context: which steps are done, plus facts and insights. */
export function productContext(over: Partial<ProductContext> & { done?: string[] } = {}): ProductContext {
  const { done = [], ...rest } = over;
  return {
    asOf: new Date(T0).toISOString(),
    steps: STEPS.map((s) => ({ id: s.id, label: s.label, done: done.includes(s.id), url: s.url })),
    nextStep: null,
    facts: [{ id: "sov", label: "Share of voice", value: 12, unit: "%" }],
    insights: [
      { id: "i_sov", sentence: "ChatGPT mentioned you in 3 of 10 answers.", factIds: ["sov"], weight: 0.8, supportsStep: null },
      { id: "i_audit", sentence: "Your audit found 4 quick fixes.", factIds: [], weight: 0.5, supportsStep: "run_audit" },
    ],
    ...rest,
  };
}

export function contextStub(get: () => ProductContext | null) {
  const calls: Array<{ userId: string; purpose: string }> = [];
  const fetchContext = async (_c: unknown, input: { userId: string; purpose: string }): Promise<ContextResult> => {
    calls.push({ userId: input.userId, purpose: input.purpose });
    const context = get();
    return context
      ? { ok: true, context, warnings: [], latencyMs: 1 }
      : { ok: false, error: "timeout", latencyMs: 5000 };
  };
  return { fetchContext, calls };
}

export function sendStub(result: (msg: EmailMessage) => EmailResult = () => ({ sent: true, provider: "mandrill", id: "m_1" })) {
  const sent: EmailMessage[] = [];
  const send = async (msg: EmailMessage): Promise<EmailResult> => {
    sent.push(msg);
    return result(msg);
  };
  return { send, sent };
}
