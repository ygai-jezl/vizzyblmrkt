import { describe, expect, it } from "vitest";
import type { ProductUser } from "@/lib/types/productUser";
import { applyUserPatch, newTombstone, tombstoneOf, userStateOf } from "../profile";
import { UserPatchSchema } from "./contract";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const connection = {
  id: "pcn_1",
  consentPolicy: { marketingBases: ["consent" as const], verifyCorporateDomain: true },
  catalog: { onboardingSteps: [{ id: "create_brand", label: "Create", order: 0 }, { id: "run_audit", label: "Audit", order: 1 }] },
};

function user(over: Partial<ProductUser> = {}): ProductUser {
  const r = applyUserPatch(null, "u_1", { email: "alex@example.com", firstName: "Alex", traits: { plan: "pro", role: "admin" } }, { connection, nowMs: NOW - 60_000 });
  if (!("next" in r)) throw new Error("setup");
  return { id: "pu_1", tenantId: "t_1", ...r.next, ...over } as ProductUser;
}

function patch(current: ProductUser | null, body: unknown, nowMs = NOW) {
  return applyUserPatch(current, "u_1", UserPatchSchema.parse(body), { connection, nowMs });
}

describe("API v2 state writes (JSON Merge Patch)", () => {
  it("creates a user from the fields sent", () => {
    const r = patch(null, { email: " Alex@Example.com ", timezone: "Europe/London", signedUpAt: "2026-09-25T11:00:00+01:00", consent: "consent" });
    expect(r).toMatchObject({ applied: true });
    if (!("next" in r)) return;
    expect(r.next).toMatchObject({ externalUserId: "u_1", email: "Alex@Example.com", timezone: "Europe/London", signedUpAt: "2026-09-25T10:00:00.000Z", status: "active" });
    expect(r.next.consent).toMatchObject({ basis: "consent", assertedBasis: "consent", source: "api" });
  });

  it("replaces what's sent, keeps what's left out, and null clears", () => {
    const r = patch(user(), { firstName: null, timezone: "America/New_York" });
    if (!("next" in r)) throw new Error("expected applied");
    expect(r.next.firstName).toBeNull();
    expect(r.next.email).toBe("alex@example.com"); // left out → kept
    expect(r.next.timezone).toBe("America/New_York");
  });

  it("merges traits, facts and steps key by key; null removes one key", () => {
    const r1 = patch(user(), { traits: { role: "editor" }, facts: { sov: 12, mentions: 3 }, steps: { create_brand: "2026-09-25T09:00:00Z" } });
    if (!("next" in r1)) throw new Error("expected applied");
    expect(r1.next.traits).toEqual({ plan: "pro", role: "editor" }); // plan kept
    const r2 = patch({ id: "pu_1", tenantId: "t_1", ...r1.next } as ProductUser, { traits: { role: null }, facts: { mentions: null }, steps: { create_brand: null } });
    if (!("next" in r2)) throw new Error("expected applied");
    expect(r2.next.traits).toEqual({ plan: "pro" });
    expect(Object.keys(r2.next.facts ?? {})).toEqual(["sov"]);
    expect(r2.next.steps).toEqual({});
  });

  it("marks activation once every catalog step is done", () => {
    const r = patch(user(), { steps: { create_brand: "2026-09-25T09:00:00Z", run_audit: "2026-09-25T10:00:00Z" } });
    if (!("next" in r)) throw new Error("expected applied");
    expect(r.next).toMatchObject({ activated: true, activatedAt: "2026-09-25T10:00:00.000Z" });
  });

  it("applies the effective consent basis (corporate on free mail = none)", () => {
    const r = patch(user({ email: "alex@gmail.com" }), { consent: "corporate_subscriber" });
    if (!("next" in r)) throw new Error("expected applied");
    expect(r.next.consent).toMatchObject({ basis: "none", assertedBasis: "corporate_subscriber" });
  });

  it("stores subscribed and excluded", () => {
    const r = patch(user(), { subscribed: false, excluded: { reason: "staff" } });
    if (!("next" in r)) throw new Error("expected applied");
    expect(r.next.subscribed).toBe(false);
    expect(r.next.excluded).toMatchObject({ reason: "staff" });
    const cleared = patch({ id: "pu_1", tenantId: "t_1", ...r.next } as ProductUser, { excluded: null });
    if (!("next" in cleared)) throw new Error("expected applied");
    expect(cleared.next.excluded).toBeNull();
  });

  it("ignores a write older than the newest one applied, and says so", () => {
    const r1 = patch(user(), { firstName: "New", updatedAt: "2026-09-25T11:00:00Z" });
    if (!("next" in r1)) throw new Error("expected applied");
    const stored = { id: "pu_1", tenantId: "t_1", ...r1.next } as ProductUser;
    expect(patch(stored, { firstName: "Old", updatedAt: "2026-09-25T10:00:00Z" })).toEqual({ skipped: "stale_write", storedUpdatedAt: "2026-09-25T11:00:00.000Z" });
    // Writes without updatedAt always apply, and don't move the bar.
    const r3 = patch(stored, { firstName: "Unstamped" });
    if (!("next" in r3)) throw new Error("expected applied");
    expect(r3.next.stateUpdatedAt).toBe("2026-09-25T11:00:00.000Z");
  });

  it("rejects a write that leaves more than 50 traits", () => {
    const traits = Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`t${i}`, i]));
    expect(patch(user(), { traits })).toEqual({ invalid: [{ path: "traits", message: "more than 50 traits after this write" }] });
  });
});

describe("API v2 tombstones", () => {
  it("keeps no user id, only the deletion time", () => {
    const t = tombstoneOf(user(), NOW);
    expect(t).toMatchObject({ status: "deleted", externalUserId: "", email: null, deletedAt: new Date(NOW).toISOString() });
    expect(t.traits).toEqual({});
  });

  it("ignores a late write older than the deletion", () => {
    const tomb = { id: "pu_1", tenantId: "t_1", ...tombstoneOf(user(), NOW) } as ProductUser;
    expect(patch(tomb, { firstName: "Ghost", updatedAt: "2026-09-25T11:59:00Z" }, NOW + 1000)).toEqual({ skipped: "deleted_later", storedUpdatedAt: null });
  });

  it("starts a fresh person on a newer write, without the tombstone's TTL", () => {
    const tomb = { id: "pu_1", tenantId: "t_1", ...tombstoneOf(user(), NOW) } as ProductUser;
    const r = patch(tomb, { email: "new@example.com", updatedAt: "2026-09-26T09:00:00Z" }, NOW + 3600_000);
    if (!("next" in r)) throw new Error("expected applied");
    expect(r.next).toMatchObject({ status: "active", externalUserId: "u_1", email: "new@example.com" });
    expect(r.next.ttlAt).toBeUndefined();
    expect(r.next.traits).toEqual({});
  });

  it("records a tombstone for a user never seen", () => {
    expect(newTombstone({ id: "pcn_1" }, NOW)).toMatchObject({ connectionId: "pcn_1", status: "deleted", externalUserId: "" });
  });
});

describe("userStateOf", () => {
  it("returns the state as the API shows it", () => {
    const r = patch(user(), { subscribed: false, facts: { sov: 12 }, steps: { create_brand: "2026-09-25T09:00:00Z" }, consent: "soft_opt_in", updatedAt: "2026-09-25T11:00:00Z" });
    if (!("next" in r)) throw new Error("expected applied");
    expect(userStateOf({ id: "pu_1", tenantId: "t_1", ...r.next } as ProductUser)).toEqual({
      userId: "u_1",
      email: "alex@example.com",
      firstName: "Alex",
      lastName: null,
      timezone: null,
      locale: null,
      signedUpAt: null,
      consent: "soft_opt_in",
      subscribed: false,
      excluded: null,
      steps: { create_brand: "2026-09-25T09:00:00.000Z" },
      facts: { sov: 12 },
      traits: { plan: "pro", role: "admin" },
      updatedAt: "2026-09-25T11:00:00.000Z",
    });
  });
});
