import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { bumpBusinessProfileRev, setBusinessProfile, startBusinessProfile } from "./control";
import { getTenantById } from "./registry";

function seeded(over: Record<string, unknown> = {}): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", {
    tenantName: "Example Co",
    rootDomain: "example.com",
    status: "active",
    region: "us",
    allowedOrigins: ["https://example.com"],
    billingTier: "mvp_free",
    ownerId: "usr_owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    brandVoice: { summary: "Warm" },
    ...over,
  });
  db.seed("tenants", "ten_B", {
    tenantName: "Other Co",
    rootDomain: "other.test",
    status: "active",
    region: "us",
    allowedOrigins: ["https://other.test"],
    ownerId: "usr_other",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  return db;
}

describe("starting a brand's profile on Home's first visit", () => {
  it("starts once: only the first call writes it, and it reads back as started", async () => {
    const db = seeded();
    expect(await startBusinessProfile("ten_A", db)).toBe(true);
    expect(await startBusinessProfile("ten_A", db)).toBe(false);
    const profile = (await getTenantById("ten_A", db))?.businessProfile;
    expect(profile).toMatchObject({ status: "started", answers: {}, rev: 0 });
    expect(profile?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(db.raw("tenants", "ten_A")!.brandVoice).toEqual({ summary: "Warm" });
    expect(db.raw("tenants", "ten_B")!.businessProfile).toBeUndefined();
  });

  it("two admins arriving together start it once", async () => {
    const db = seeded();
    const [a, b] = await Promise.all([startBusinessProfile("ten_A", db), startBusinessProfile("ten_A", db)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("never starts over a damaged value, and never for a missing brand", async () => {
    const db = seeded({ businessProfile: { status: "who knows" } });
    expect(await startBusinessProfile("ten_A", db)).toBe(false);
    // A damaged value reads as none, so Home's check passes, but the start refuses: never shown twice.
    expect((await getTenantById("ten_A", db))?.businessProfile).toBeUndefined();
    expect(await startBusinessProfile("ten_missing", db)).toBe(false);
  });
});

describe("changing a brand's profile", () => {
  it("merges answers, bumps rev only when an answer changes, and notes how they came", async () => {
    const db = seeded();
    await startBusinessProfile("ten_A", db);
    const one = await setBusinessProfile("ten_A", { answers: { who: "solo" }, via: "questions" }, db);
    expect(one?.before).toMatchObject({ status: "started", rev: 0 });
    expect(one?.after).toMatchObject({ status: "started", via: "questions", answers: { who: "solo" }, rev: 1 });
    const two = await setBusinessProfile("ten_A", { answers: { run: "shop" }, via: "questions" }, db);
    expect(two?.after).toMatchObject({ answers: { who: "solo", run: "shop" }, rev: 2 });
    // The same answer again changes nothing and writes nothing.
    const writes = db.writeCountFor("tenants", "ten_A");
    const same = await setBusinessProfile("ten_A", { answers: { run: "shop" }, via: "settings" }, db);
    expect(same?.after).toEqual(same?.before);
    expect(same?.after.via).toBe("questions");
    expect(db.writeCountFor("tenants", "ten_A")).toBe(writes);
    // A changed answer replaces the old one.
    const three = await setBusinessProfile("ten_A", { answers: { run: "service" }, via: "settings" }, db);
    expect(three?.after).toMatchObject({ via: "settings", answers: { who: "solo", run: "service" }, rev: 3 });
    expect((await getTenantById("ten_A", db))?.businessProfile).toMatchObject({ answers: { who: "solo", run: "service" }, rev: 3 });
    expect(db.raw("tenants", "ten_B")!.businessProfile).toBeUndefined();
  });

  it("finishes with done, and a skip never beats done", async () => {
    const db = seeded();
    await startBusinessProfile("ten_A", db);
    const done = await setBusinessProfile("ten_A", { status: "done", answers: { want: "audience" }, via: "questions" }, db);
    expect(done?.before?.status).toBe("started");
    expect(done?.after).toMatchObject({ status: "done", via: "questions", rev: 1 });
    const skip = await setBusinessProfile("ten_A", { status: "skipped" }, db);
    expect(skip?.after.status).toBe("done");
    expect((await getTenantById("ten_A", db))?.businessProfile?.status).toBe("done");
  });

  it("skips only from started, and done still follows a skip", async () => {
    const db = seeded();
    await startBusinessProfile("ten_A", db);
    const skip = await setBusinessProfile("ten_A", { status: "skipped" }, db);
    expect(skip?.after).toMatchObject({ status: "skipped", rev: 0 });
    expect(skip?.after.via).toBeUndefined();
    const done = await setBusinessProfile("ten_A", { status: "done", via: "questions" }, db);
    expect(done?.after).toMatchObject({ status: "done", via: "questions" });
  });

  it("gives a brand with no profile one that is done, so Settings never starts the welcome's flow", async () => {
    const db = seeded();
    const r = await setBusinessProfile("ten_A", { answers: { stage: "idea" }, via: "settings" }, db);
    expect(r?.before).toBeNull();
    expect(r?.after).toMatchObject({ status: "done", via: "settings", answers: { stage: "idea" }, rev: 1 });
    expect(r?.after.startedAt).toBe(r?.after.updatedAt);
  });

  it("treats a damaged profile as none, and drops a damaged answer on its own", async () => {
    const damaged = seeded({ businessProfile: { status: "started", answers: "nope", startedAt: 7 } });
    const r = await setBusinessProfile("ten_A", { answers: { who: "team" }, via: "questions" }, damaged);
    expect(r?.before).toBeNull();
    expect(r?.after).toMatchObject({ status: "done", answers: { who: "team" }, rev: 1 });

    const oneBad = seeded({
      businessProfile: { status: "started", answers: { who: "robot", run: "app" }, rev: 4, startedAt: "2026-11-01T00:00:00.000Z" },
    });
    const kept = await setBusinessProfile("ten_A", { answers: { stage: "launched" } }, oneBad);
    expect(kept?.before?.answers).toEqual({ run: "app" });
    expect(kept?.after).toMatchObject({ answers: { run: "app", stage: "launched" }, rev: 5, startedAt: "2026-11-01T00:00:00.000Z" });
  });

  it("refuses an answer that isn't one of the choices, and a brand that doesn't exist", async () => {
    const db = seeded();
    await expect(setBusinessProfile("ten_A", { answers: { who: "robot" } as never }, db)).rejects.toThrow();
    await expect(setBusinessProfile("ten_A", { answers: { colour: "blue" } as never }, db)).rejects.toThrow();
    expect(await setBusinessProfile("ten_missing", { answers: { who: "solo" } }, db)).toBeNull();
  });
});

describe("bumping the profile's rev", () => {
  it("goes up by one with a profile, and does nothing without one", async () => {
    const db = seeded();
    expect(await bumpBusinessProfileRev("ten_A", db)).toBeNull();
    await startBusinessProfile("ten_A", db);
    expect(await bumpBusinessProfileRev("ten_A", db)).toBe(1);
    expect(await bumpBusinessProfileRev("ten_A", db)).toBe(2);
    expect((await getTenantById("ten_A", db))?.businessProfile).toMatchObject({ status: "started", rev: 2 });
    expect(await bumpBusinessProfileRev("ten_missing", db)).toBeNull();
  });
});
