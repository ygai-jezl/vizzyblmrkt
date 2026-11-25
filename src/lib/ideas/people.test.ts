import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { T0, TENANT_ID, ctx, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import { sweepPeople } from "@/lib/audience/personSweep";
import { personIdOf, syncPerson } from "@/lib/audience/personSync";
import type { TenantContext } from "@/lib/tenant/types";
import { flagLaunchPeople, mayChangeMany } from "./people";
import { setIdea } from "./service";

/**
 * People after Just a list moves: the save only records that they're owed a sync, and the lifecycle
 * tick flags, a page at a time, the ones whose "in more than one launch" can change.
 */

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const T1 = "2026-11-25T09:00:00.000Z";
const at = (ms: number, deadlineMs = ms + 60_000) => ({ now: () => ms, deadlineMs });
const NOW = Date.parse(T1);

beforeEach(() => vi.stubEnv("LAUNCH_IDEAS_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("mayChangeMany", () => {
  it("ticked, picks only someone on the launch with the tag; unticked, only someone on it and another, without the tag", () => {
    expect(mayChangeMany(["all", "launch:any", "launch:news", "launch:beta", "launches:many"], "news", true)).toBe(true);
    expect(mayChangeMany(["all", "launch:any", "launch:beta", "launch:gamma", "launches:many"], "news", true)).toBe(false);
    expect(mayChangeMany(["all", "launch:any", "launch:news"], "news", true)).toBe(false);

    expect(mayChangeMany(["all", "launch:any", "launch:news", "launch:beta"], "news", false)).toBe(true);
    // On this launch alone: never had the tag, never will from this.
    expect(mayChangeMany(["all", "launch:any", "launch:news"], "news", false)).toBe(false);
    expect(mayChangeMany(["all", "launch:any", "launch:news", "launch:beta", "launches:many"], "news", false)).toBe(false);
    expect(mayChangeMany(null, "news", false)).toBe(false);
  });
});

/** A newsletter launch, with people on it alone, on it and one more, and on two others. */
function brand(people: number) {
  const db = new FakeFirestore();
  db.seed("campaigns", "news", { tenantId: "ten_A", waitlistName: "News", createdAt: "2026-10-01T09:00:00.000Z" });
  for (let i = 0; i < people; i += 1) {
    db.seed("contacts", `ct_${i}`, { tenantId: "ten_A", memberOf: ["all", "launch:any", "launch:news"], sortKey: `2026-11-01|${String(i).padStart(4, "0")}`, needsSync: false });
  }
  db.seed("contacts", "ct_both", { tenantId: "ten_A", memberOf: ["all", "launch:any", "launch:beta", "launch:news", "launches:many"], sortKey: "2026-11-02|both", needsSync: false });
  db.seed("contacts", "ct_two", { tenantId: "ten_A", memberOf: ["all", "launch:any", "launch:beta", "launch:gamma", "launches:many"], sortKey: "2026-11-03|two", needsSync: false });
  // Another brand's person, on a launch with the same tag.
  db.seed("contacts", "ct_theirs", { tenantId: "ten_B", memberOf: ["all", "launch:any", "launch:news", "launch:beta", "launches:many"], sortKey: "2026-11-04|theirs", needsSync: false });
  return db;
}
const IDS = ["ct_0", "ct_1", "ct_2", "ct_3", "ct_4", "ct_both", "ct_two", "ct_theirs"];
const flagged = (db: FakeFirestore) => IDS.filter((id) => db.raw("contacts", id)?.needsSync === true);

describe("ticking Just a list", () => {
  it("answers without touching anyone: it records that the launch's people are owed a sync", async () => {
    const db = brand(30);
    const r = await setIdea(A, "news", { justAList: true }, { db, nowIso: T1 });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(flagged(db)).toEqual([]);
    expect(db.raw("campaigns", "news")?.peopleResync).toEqual({ owed: true, since: T1, cursor: null });
    // A save that leaves Just a list as it is owes nothing new.
    db.seed("campaigns", "news", { ...db.raw("campaigns", "news"), peopleResync: null });
    await setIdea(A, "news", { justAList: true, hypothesis: "Still a list." }, { db, nowIso: T1 });
    expect(db.raw("campaigns", "news")?.peopleResync).toBeNull();
  });

  it("then flags only the people whose tag can change, and is done", async () => {
    const db = brand(30);
    await setIdea(A, "news", { justAList: true }, { db, nowIso: T1 });
    expect(await flagLaunchPeople(A, { db, ...at(NOW) })).toBe(1);
    expect(flagged(db)).toEqual(["ct_both"]);
    expect(db.raw("campaigns", "news")?.peopleResync).toBeNull();

    // Unticked: someone on it and another launch, not those on it alone or already tagged.
    db.seed("contacts", "ct_both", { ...db.raw("contacts", "ct_both"), memberOf: ["all", "launch:any", "launch:beta", "launch:news"], needsSync: false });
    await setIdea(A, "news", { justAList: false }, { db, nowIso: T1 });
    expect(await flagLaunchPeople(A, { db, ...at(NOW) })).toBe(1);
    expect(flagged(db)).toEqual(["ct_both"]);
  });

  it("goes a page at a time across ticks, from where it stopped", async () => {
    const db = brand(5);
    for (const id of ["ct_0", "ct_2", "ct_4"]) {
      db.seed("contacts", id, { ...db.raw("contacts", id), memberOf: ["all", "launch:any", "launch:news", "launch:beta"] });
    }
    await setIdea(A, "news", { justAList: false, status: "testing" }, { db, nowIso: T1 });
    db.seed("campaigns", "news", { ...db.raw("campaigns", "news"), peopleResync: { owed: true, since: T1, cursor: null } });
    // Out of time after the first page of two.
    let clock = NOW;
    const deadlineMs = NOW + 15;
    const deps = { db, now: () => (clock += 6), deadlineMs, pageSize: 2 };
    await flagLaunchPeople(A, deps);
    const cursor = (db.raw("campaigns", "news")?.peopleResync as { cursor: string | null }).cursor;
    expect(cursor).not.toBeNull();
    const firstTick = flagged(db);
    expect(firstTick).toEqual(["ct_4"]);

    await flagLaunchPeople(A, { db, ...at(NOW), pageSize: 2 });
    expect(flagged(db)).toEqual(["ct_0", "ct_2", "ct_4"]);
    expect(flagged(db)).toEqual(expect.arrayContaining(firstTick));
    expect(db.raw("campaigns", "news")?.peopleResync).toBeNull();
  });

  it("starts over when Just a list moves again meanwhile", async () => {
    const db = brand(3);
    await setIdea(A, "news", { justAList: true }, { db, nowIso: T1 });
    const moved = { owed: true, since: "2026-11-25T09:05:00.000Z", cursor: null };
    let calls = 0;
    await flagLaunchPeople(A, {
      db,
      deadlineMs: NOW + 100,
      pageSize: 1,
      now: () => {
        // The admin unticks it while the tick is on its first page.
        if (++calls === 2) db.seed("campaigns", "news", { ...db.raw("campaigns", "news"), idea: { justAList: false }, peopleResync: moved });
        return NOW;
      },
    });
    expect(db.raw("campaigns", "news")?.peopleResync).toEqual(moved);
  });
});

describe("in the lifecycle tick", () => {
  const SAM = "sam@example.com";
  function world(): FakeFirestore {
    const db = new FakeFirestore();
    seedWorld(db);
    for (const id of ["camp1", "camp2"]) db.seed("campaigns", id, { tenantId: TENANT_ID, waitlistName: id, createdAt: new Date(T0).toISOString() });
    for (const [id, campaignId] of [
      ["sig_1", "camp1"],
      ["sig_2", "camp2"],
    ] as const) {
      db.seed("signups", id, {
        tenantId: TENANT_ID,
        campaignId,
        email: SAM,
        phone: null,
        firstName: "Sam",
        lastName: "Rivera",
        verified: true,
        captchaValid: true,
        isSpam: false,
        status: "verified_active",
        amountReferred: 0,
        referralToken: `ref_${id}`,
        referralLink: `https://example.test/r/${id}`,
        score: 0,
        createdAt: new Date(T0).toISOString(),
      });
    }
    return db;
  }
  const tags = (db: FakeFirestore) => (db.raw("contacts", personIdOf(TENANT_ID, SAM))?.memberOf as string[]) ?? [];

  it("moves someone out of, and back into, in more than one launch within a tick", async () => {
    const db = world();
    await syncPerson(ctx, SAM, { db, nowMs: T0 });
    expect(tags(db)).toContain("launches:many");
    // Before the daily check's hour, so only the owed work runs.
    const tick = Date.parse("2026-09-22T03:00:00Z");

    await setIdea(ctx, "camp2", { justAList: true }, { db });
    expect(tags(db)).toContain("launches:many");
    expect(await sweepPeople(ctx, { db, ...at(tick) })).toMatchObject({ synced: 1, failed: 0 });
    expect(tags(db)).not.toContain("launches:many");
    expect(db.raw("campaigns", "camp2")?.peopleResync).toBeNull();

    await setIdea(ctx, "camp2", { justAList: false }, { db });
    expect(await sweepPeople(ctx, { db, ...at(tick + 120_000) })).toMatchObject({ synced: 1, failed: 0 });
    expect(tags(db)).toContain("launches:many");
  });

  it("leaves the record owed while ideas are off", async () => {
    const db = world();
    await syncPerson(ctx, SAM, { db, nowMs: T0 });
    await setIdea(ctx, "camp2", { justAList: true }, { db });
    vi.stubEnv("LAUNCH_IDEAS_ENABLED", "false");
    expect(await sweepPeople(ctx, { db, ...at(Date.parse("2026-09-22T03:00:00Z")) })).toMatchObject({ synced: 0 });
    expect(db.raw("campaigns", "camp2")?.peopleResync).toMatchObject({ owed: true });
  });
});
