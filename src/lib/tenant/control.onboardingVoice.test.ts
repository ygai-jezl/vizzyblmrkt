import { describe, expect, it } from "vitest";
import { voiceDayOf } from "@/lib/types/businessProfile";
import { FakeFirestore } from "./testing/fakeFirestore";
import { claimVoiceStart, markVoiceDone, releaseVoiceStart } from "./control";
import { getTenantById } from "./registry";

const DAY = "2026-11-25";
const NEXT = "2026-11-26";

function seeded(over: Record<string, unknown> = {}): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", {
    tenantName: "Example Co",
    rootDomain: "example.com",
    status: "active",
    region: "us",
    allowedOrigins: ["https://example.com"],
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

describe("Talk with Vizzy's daily allowance", () => {
  it("counts the UTC day", () => {
    expect(voiceDayOf(Date.parse("2026-11-25T23:59:59.000Z"))).toBe(DAY);
    expect(voiceDayOf("2026-11-26T00:00:00.000Z")).toBe(NEXT);
  });

  it("gives three starts a day, then refuses, and leaves the rest of the brand alone", async () => {
    const db = seeded();
    expect(await claimVoiceStart("ten_A", DAY, db)).toBe("ok");
    expect(await claimVoiceStart("ten_A", DAY, db)).toBe("ok");
    expect(await claimVoiceStart("ten_A", DAY, db)).toBe("ok");
    expect(await claimVoiceStart("ten_A", DAY, db)).toBe("too_many");
    expect(db.raw("tenants", "ten_A")!.onboardingVoice).toEqual({ day: DAY, starts: 3, done: false });
    expect(db.raw("tenants", "ten_A")!.brandVoice).toEqual({ summary: "Warm" });
    expect(db.raw("tenants", "ten_B")!.onboardingVoice).toBeUndefined();
    expect((await getTenantById("ten_A", db))?.onboardingVoice).toEqual({ day: DAY, starts: 3, done: false });
  });

  it("refuses the rest of the day once a call is done, and starts fresh the next day", async () => {
    const db = seeded();
    expect(await claimVoiceStart("ten_A", DAY, db)).toBe("ok");
    expect(await markVoiceDone("ten_A", DAY, db)).toBe(true);
    expect(await claimVoiceStart("ten_A", DAY, db)).toBe("done_today");
    expect(await claimVoiceStart("ten_A", NEXT, db)).toBe("ok");
    expect(db.raw("tenants", "ten_A")!.onboardingVoice).toEqual({ day: NEXT, starts: 1, done: false });
  });

  it("gives a start back only for its own day, never below none", async () => {
    const db = seeded();
    expect(await releaseVoiceStart("ten_A", DAY, db)).toBe(false);
    await claimVoiceStart("ten_A", DAY, db);
    expect(await releaseVoiceStart("ten_A", NEXT, db)).toBe(false);
    expect(await releaseVoiceStart("ten_A", DAY, db)).toBe(true);
    expect(db.raw("tenants", "ten_A")!.onboardingVoice).toEqual({ day: DAY, starts: 0, done: false });
    expect(await releaseVoiceStart("ten_A", DAY, db)).toBe(false);
  });

  it("marks done only the stored day: a call from yesterday ending today changes nothing", async () => {
    const db = seeded();
    await claimVoiceStart("ten_A", NEXT, db);
    expect(await markVoiceDone("ten_A", DAY, db)).toBe(false);
    expect(db.raw("tenants", "ten_A")!.onboardingVoice).toEqual({ day: NEXT, starts: 1, done: false });
    expect(await markVoiceDone("ten_A", NEXT, db)).toBe(true);
    expect(await markVoiceDone("ten_A", NEXT, db)).toBe(true);
  });

  it("reads a damaged value as none today, and a missing brand as missing", async () => {
    const db = seeded({ onboardingVoice: { day: "yesterday", starts: "lots", done: "no" } });
    expect((await getTenantById("ten_A", db))?.onboardingVoice).toBeUndefined();
    expect(await claimVoiceStart("ten_A", DAY, db)).toBe("ok");
    expect(db.raw("tenants", "ten_A")!.onboardingVoice).toEqual({ day: DAY, starts: 1, done: false });
    expect(await claimVoiceStart("ten_missing", DAY, db)).toBe("missing");
    expect(await markVoiceDone("ten_missing", DAY, db)).toBe(false);
    expect(await releaseVoiceStart("ten_missing", DAY, db)).toBe(false);
  });

  it("two starts at once with one left: only one gets it", async () => {
    const db = seeded({ onboardingVoice: { day: DAY, starts: 2, done: false } });
    const both = await Promise.all([claimVoiceStart("ten_A", DAY, db), claimVoiceStart("ten_A", DAY, db)]);
    expect(both.sort()).toEqual(["ok", "too_many"]);
  });
});
