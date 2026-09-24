import type { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

/** Test fixtures for invites. Synthetic people only (example.test addresses). */

export const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system", userId: "u_admin", role: "admin" };

export function seedLaunch(db: FakeFirestore, over: Record<string, unknown> = {}): void {
  db.seed("campaigns", "beta", {
    tenantId: "ten_A",
    name: "Fernlight Beta",
    productName: "Fernlight",
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  });
}

/** A verified person on the "beta" waitlist; `amountReferred` sets their rank (higher = earlier). */
export function seedSignup(db: FakeFirestore, id: string, over: Record<string, unknown> = {}): void {
  db.seed("signups", id, {
    tenantId: "ten_A",
    campaignId: "beta",
    firstName: id,
    lastName: "Test",
    email: `${id}@example.test`,
    phone: null,
    verified: true,
    captchaValid: true,
    isSpam: false,
    status: "verified_active",
    amountReferred: 0,
    referralToken: `ref_${id}`,
    referralLink: `https://fernlight.test/?ref=${id}`,
    score: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...over,
  });
}

export function seedConnection(db: FakeFirestore, id = "pcn_prod", over: Record<string, unknown> = {}): void {
  db.seed("product_connections", id, {
    tenantId: "ten_A",
    name: "Fernlight",
    kind: "custom",
    status: "active",
    environment: "production",
    signupUrl: "https://app.fernlight.test/signup",
    linkDomains: ["fernlight.test"],
    catalog: { events: [], traits: [], onboardingSteps: [], facts: [], glossary: [] },
    consentPolicy: { marketingBases: ["consent"], verifyCorporateDomain: true },
    defaults: { timezone: "Europe/London", locale: "en" },
    createdAt: "2026-09-01T00:00:00.000Z",
    ...over,
  });
}
