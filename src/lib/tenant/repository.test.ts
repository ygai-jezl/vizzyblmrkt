import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { forTenant } from "./repository";
import { TenantIsolationError, TenantValidationError } from "./errors";
import type { TenantContext } from "./types";

const ctxA: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const ctxB: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };

function signup(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignId: "camp1",
    email: "x@example.com",
    verified: true,
    captchaValid: true,
    isSpam: false,
    status: "verified_active",
    amountReferred: 0,
    referralToken: "TOK",
    referralLink: "https://x/?ref=TOK",
    score: 0,
    createdAt: "2026-06-15T16:00:00Z",
    ...over,
  };
}

describe("TenantCollection isolation", () => {
  it("stamps the trusted tenantId on create and ignores caller-supplied tenantId/id", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctxA, db);
    // Attacker tries to smuggle a foreign tenantId + id into the payload.
    await repo.signups.create("s1", {
      ...signup(),
      tenantId: "ten_EVIL",
      id: "evil_id",
    } as never);

    const raw = db.raw("signups", "s1")!;
    expect(raw.tenantId).toBe("ten_A");
    expect(db.raw("signups", "evil_id")).toBeUndefined();
  });

  it("create() refuses to overwrite an existing id belonging to another tenant", async () => {
    const db = new FakeFirestore();
    // Tenant B owns a campaign with a guessable slug id.
    db.seed("campaigns", "beta-launch", {
      tenantId: "ten_B",
      waitlistName: "B's campaign",
    });

    // Tenant A tries to hijack/destroy it by creating the same id.
    await expect(
      forTenant(ctxA, db).campaigns.create("beta-launch", {
        waitlistName: "A's campaign",
      } as never),
    ).rejects.toBeInstanceOf(TenantIsolationError);

    // Tenant B's document is untouched.
    const raw = db.raw("campaigns", "beta-launch")!;
    expect(raw.tenantId).toBe("ten_B");
    expect(raw.waitlistName).toBe("B's campaign");
  });

  it("create() refuses to overwrite an id within the same tenant (no silent clobber)", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctxA, db);
    await repo.signups.create("s1", signup() as never);
    await expect(repo.signups.create("s1", signup() as never)).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });

  it("find() is always scoped to the context tenant", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "s1", signup({ tenantId: "ten_A" }));
    db.seed("signups", "s2", signup({ tenantId: "ten_B" }));

    const got = await forTenant(ctxA, db).signups.find();
    expect(got.map((s) => s.id)).toEqual(["s1"]);
  });

  it("a caller cannot widen the result set by overriding the tenant filter", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "s1", signup({ tenantId: "ten_A" }));
    db.seed("signups", "s2", signup({ tenantId: "ten_B" }));

    // Malicious attempt to read tenant B's data from tenant A's context.
    const got = await forTenant(ctxA, db).signups.find({
      where: [["tenantId", "==", "ten_B"]],
    });
    expect(got.map((s) => s.id)).toEqual(["s1"]); // override ignored; still A-only
  });

  it("getById() returns null for a document belonging to another tenant", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "s2", signup({ tenantId: "ten_B" }));

    // THE cross-tenant negative test: A guesses B's document id.
    expect(await forTenant(ctxA, db).signups.getById("s2")).toBeNull();
    // B can read its own document.
    expect((await forTenant(ctxB, db).signups.getById("s2"))?.id).toBe("s2");
  });

  it("count() is tenant-scoped", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "s1", signup({ tenantId: "ten_A" }));
    db.seed("signups", "s2", signup({ tenantId: "ten_B" }));
    db.seed("signups", "s3", signup({ tenantId: "ten_A" }));

    expect(await forTenant(ctxA, db).signups.count()).toBe(2);
    expect(await forTenant(ctxB, db).signups.count()).toBe(1);
  });

  it("refuses cross-tenant update/delete and leaves the foreign doc intact", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "s2", signup({ tenantId: "ten_B", isSpam: false }));
    const repoA = forTenant(ctxA, db);

    await expect(repoA.signups.update("s2", { isSpam: true })).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    await expect(repoA.signups.delete("s2")).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    expect(db.raw("signups", "s2")!.isSpam).toBe(false);
    expect(db.raw("signups", "s2")).toBeDefined();
  });

  it("allows update/delete within the same tenant", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctxA, db);
    await repo.signups.create("s1", signup() as never);

    await repo.signups.update("s1", { isSpam: true });
    expect(db.raw("signups", "s1")!.isSpam).toBe(true);

    await repo.signups.delete("s1");
    expect(db.raw("signups", "s1")).toBeUndefined();
  });

  it("forTenant() rejects a context without a tenantId", () => {
    const db = new FakeFirestore();
    expect(() =>
      forTenant({ tenantId: "", region: "us", source: "system" }, db),
    ).toThrow(TenantValidationError);
  });

  it("forTenant() rejects a context without a region (residency guardrail)", () => {
    const db = new FakeFirestore();
    expect(() =>
      // region intentionally omitted — must throw, never silently default.
      forTenant({ tenantId: "ten_A", source: "system" } as never, db),
    ).toThrow(TenantValidationError);
  });
});
