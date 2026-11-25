import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { loadGrowthSignals } from "@/lib/nav/growthSignals";
import { shouldWelcome, type FirstVisitTenant } from "./firstVisit";

const ctx: TenantContext = { tenantId: "ten_new", region: "us", source: "system" };
const fresh = { businessProfile: undefined };
const nothing = { recordsEver: 0, signups: 0 };

/** What Home reads, for a brand seeded with `seed`. */
async function signalsFor(seed: (db: FakeFirestore) => void = () => {}) {
  const db = new FakeFirestore();
  seed(db);
  return loadGrowthSignals(ctx, { lifecycle: true }, db);
}

describe("who Home sends to the welcome", () => {
  it("a new brand's admin", async () => {
    expect(shouldWelcome(fresh, await signalsFor(), "admin")).toBe(true);
  });

  it("never a member, nor someone whose role isn't known", () => {
    expect(shouldWelcome(fresh, nothing, "member")).toBe(false);
    expect(shouldWelcome(fresh, nothing, undefined)).toBe(false);
  });

  it("never when the brand, its records or its sign-ups couldn't be read", async () => {
    expect(shouldWelcome(null, nothing, "admin")).toBe(false);
    expect(shouldWelcome(fresh, { recordsEver: 0, signups: null }, "admin")).toBe(false);
    expect(shouldWelcome(fresh, { recordsEver: null, signups: 0 }, "admin")).toBe(false);
    const failed = await loadGrowthSignals(ctx, { lifecycle: true }, failingFirestore(new FakeFirestore(), { collections: ["campaigns"] }));
    expect(shouldWelcome(fresh, failed, "admin")).toBe(false);
  });

  it("never again once the brand has a profile, whatever its status", () => {
    for (const status of ["started", "done", "skipped"] as const) {
      expect(shouldWelcome({ businessProfile: { status, answers: {}, rev: 0, startedAt: "2026-11-25T10:00:00.000Z" } }, nothing, "admin")).toBe(false);
    }
  });

  it("never for a brand whose only launch is archived", async () => {
    const s = await signalsFor((db) =>
      db.seed("campaigns", "c_arch", { tenantId: "ten_new", waitlistName: "Gone", createdAt: "2026-09-10T00:00:00Z", archivedAt: "2026-09-11T00:00:00Z" }),
    );
    expect(s.activeLaunches).toBe(0);
    expect(shouldWelcome(fresh, s, "admin")).toBe(false);
  });

  it("never for a brand with only a sandbox connection", async () => {
    const s = await signalsFor((db) =>
      db.seed("product_connections", "pc_sandbox", { tenantId: "ten_new", kind: "sandbox", status: "active", createdAt: "2026-09-03T00:00:00Z" }),
    );
    expect(s.products).toBe(0);
    expect(shouldWelcome(fresh, s, "admin")).toBe(false);
  });

  it("never for a brand with sign-ups, even with nothing else", async () => {
    const s = await signalsFor((db) => db.seed("signups", "s1", { tenantId: "ten_new", status: "unverified", createdAt: "2026-09-01T00:00:00Z" }));
    expect(s.recordsEver).toBe(0);
    expect(shouldWelcome(fresh, s, "admin")).toBe(false);
  });

  it("another brand's records don't count against a new one", async () => {
    const s = await signalsFor((db) => db.seed("campaigns", "c_b", { tenantId: "ten_B", waitlistName: "Theirs", createdAt: "2026-09-10T00:00:00Z" }));
    expect(shouldWelcome(fresh, s, "admin")).toBe(true);
  });

  describe("never for a brand partway through setup, with nothing made and no sign-ups", () => {
    const domain = (status: string) => ({ domain: "mail.fernhill.test", status, records: [] });
    const cases: Array<[string, FirstVisitTenant]> = [
      ["a verified sending domain", { emailSenderConfig: { domains: [domain("verified")] } } as unknown as FirstVisitTenant],
      ["a sending domain still to verify", { emailSenderConfig: { domains: [domain("pending")] } } as unknown as FirstVisitTenant],
      ["a sender name, with no domain yet", { emailSenderConfig: { senderName: "Fernhill Plants", domains: [] } }],
      ["LinkedIn or X connected", { socialConnections: { linkedin: { provider: "linkedin" } } } as unknown as FirstVisitTenant],
      ["GitHub connected", { gitConnections: { github: { provider: "github" } } } as unknown as FirstVisitTenant],
      ["a brand voice written", { brandVoice: { summary: "Warm and plain, like a friend who knows plants." } }],
      ["a brand voice with only dos", { brandVoice: { dos: ["Say what the plant needs"] } }],
    ];
    for (const [what, tenant] of cases) {
      it(what, () => {
        expect(shouldWelcome(tenant, nothing, "admin")).toBe(false);
      });
    }

    it("a saved brand map (the setup guide's read)", () => {
      expect(shouldWelcome(fresh, { ...nothing, setup: { brandMapSaved: true } }, "admin")).toBe(false);
    });

    it("but an empty sender config, an empty voice, or a brand map not saved or not known still welcomes a new brand", () => {
      expect(shouldWelcome({ emailSenderConfig: { domains: [] }, brandVoice: { summary: " ", dos: [] }, socialConnections: {} }, nothing, "admin")).toBe(true);
      expect(shouldWelcome(fresh, { ...nothing, setup: { brandMapSaved: false } }, "admin")).toBe(true);
      expect(shouldWelcome(fresh, { ...nothing, setup: { brandMapSaved: null } }, "admin")).toBe(true);
    });
  });
});
