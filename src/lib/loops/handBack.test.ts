import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOOP_DAYS, loopDayId } from "@/lib/tenant/loops";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { handBack, SAVE_TOKENS_MAX, stampsFromTokens, TOKEN_SAVES, withStampToken } from "./handBack";
import { learnedFor } from "./read";
import { STAMP_HEADER, stampHeaders, tokensFromRequest } from "./stampHeader";
import { sumWeek } from "./testing/sumWeek";

/**
 * The browser round trip (learning loops step 5, decision 20 and 4.2 of the plan for steps 4
 * and 5): an output handed to the browser is counted made once and, where its save checks one
 * (TOKEN_SAVES), its stamp signed; the save checks the token it brings back, and counts a refused
 * one. Hearth Bakery and Lumen are made up.
 */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "eu", source: "idtoken" };
const lumen: TenantContext = { tenantId: "ten_lumen", region: "eu", source: "idtoken" };
const NOW = new Date("2027-01-15T10:00:00.000Z");
const WEEK = "2027-W02";

const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`touched the database (${String(p)})`); } }) as FirestoreLike;

afterEach(() => vi.unstubAllEnvs());

describe("with LOOPS_ENABLED off", () => {
  it("hands back no token, counts nothing and reads no key at the save, so the JSON is as before", async () => {
    const { stamp } = await learnedFor(hearth, "brand_voice");
    expect(await handBack(hearth, "brand_voice", stamp, { db: untouchable })).toBeNull();
    expect(withStampToken({ brandVoice: { summary: "Warm" } }, null)).toEqual({ brandVoice: { summary: "Warm" } });
    expect(await stampsFromTokens(hearth, ["brand_voice"], ["st1.a.b"], { db: untouchable })).toEqual([]);
  });
});

describe("with LOOPS_ENABLED on", () => {
  beforeEach(() => vi.stubEnv("LOOPS_ENABLED", "true"));

  it("counts the output made once and hands back a token the save takes back as the same stamp", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(hearth, "brand_voice", {}, { now: NOW });
    const token = await handBack(hearth, "brand_voice", stamp, { db, now: NOW });
    expect(token).toMatch(/^st1\./);
    expect(withStampToken({ ok: true }, token)).toEqual({ ok: true, stampToken: token });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toMatchObject({ c: { brand_voice: { brand_voice: { v0: { none: { made: 1 } } } } } });
    // The token holds no key and no brand.
    expect(Buffer.from(token!.split(".")[1]!, "base64url").toString("utf8")).not.toContain("hearth");
    expect(await stampsFromTokens(hearth, ["brand_voice"], [token], { db, now: NOW })).toEqual([stamp]);
  });

  it("signs no token for a kind whose save checks none, and still counts it made", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(hearth, "email_copy", {}, { now: NOW });
    expect(TOKEN_SAVES.has("email_copy")).toBe(false);
    expect(await handBack(hearth, "email_copy", stamp, { db, now: NOW })).toBeNull();
    expect(sumWeek(db, hearth.tenantId, WEEK)).toMatchObject({ c: { email_copy: { email_copy: { v0: { none: { made: 1 } } } } } });
    // No key was read or minted for a token no save would check.
    expect(db.raw(LOOP_DAYS, loopDayId.key(hearth.tenantId))).toBeUndefined();
    expect([...TOKEN_SAVES].sort()).toEqual(["brand_kit", "brand_notes", "brand_voice"]);
  });

  it("refuses and counts a changed, foreign, expired or wrong kind's token, and leaves it out", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(hearth, "brand_voice", {}, { now: NOW });
    const token = (await handBack(hearth, "brand_voice", stamp, { db, now: NOW }))!;
    const [p, body, sig] = token.split(".");
    const forged = `${p}.${Buffer.from(Buffer.from(body!, "base64url").toString("utf8").replace('"v":0', '"v":9'), "utf8").toString("base64url")}.${sig}`;
    const theirs = (await handBack(lumen, "brand_voice", (await learnedFor(lumen, "brand_voice")).stamp, { db, now: NOW }))!;
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    expect(await stampsFromTokens(hearth, ["brand_voice"], [forged, theirs, "junk"], { db, now: NOW })).toEqual([]);
    expect(await stampsFromTokens(hearth, ["brand_voice"], [token], { db, now: later })).toEqual([]);
    expect(await stampsFromTokens(hearth, ["brand_kit"], [token], { db, now: NOW })).toEqual([]);
    expect(sumWeek(db, hearth.tenantId, WEEK)).toMatchObject({ u: { brand_voice: { token_signature: 2, token_malformed: 1 }, brand_kit: { token_invalid: 1 } } });
    expect(sumWeek(db, hearth.tenantId, "2027-W03")).toMatchObject({ u: { brand_voice: { token_expired: 1 } } });
  });

  it("reads the brand's key once for a save's tokens, and writes its refusals once", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(hearth, "brand_kit", {}, { now: NOW });
    const token = (await handBack(hearth, "brand_kit", stamp, { db, now: NOW }))!;
    const [p, body] = token.split(".");
    const forged = `${p}.${body}.${Buffer.from("not the signature").toString("base64url")}`;
    const before = db.collectionCalls(LOOP_DAYS);
    const got = await stampsFromTokens(hearth, ["brand_kit"], [token, token, token, forged, forged, "junk"], { db, now: NOW });
    expect(got).toEqual([stamp, stamp, stamp]);
    // One read of the key and one write of the refusals, however many tokens came.
    expect(db.collectionCalls(LOOP_DAYS) - before).toBe(2);
    expect(sumWeek(db, hearth.tenantId, WEEK)).toMatchObject({ u: { brand_kit: { token_signature: 2, token_malformed: 1 } } });
  });

  it("reads no key for a save whose tokens are none of them tokens", async () => {
    const db = new FakeFirestore();
    await stampsFromTokens(hearth, ["brand_kit"], ["junk", 7, null], { db, now: NOW });
    expect(db.raw(LOOP_DAYS, loopDayId.key(hearth.tenantId))).toBeUndefined();
  });

  it("checks at most SAVE_TOKENS_MAX tokens a save", async () => {
    const db = new FakeFirestore();
    const many = Array.from({ length: SAVE_TOKENS_MAX + 5 }, () => "junk");
    await stampsFromTokens(hearth, ["brand_kit"], many, { db, now: NOW });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toMatchObject({ u: { brand_kit: { token_malformed: SAVE_TOKENS_MAX } } });
  });
});

describe("the save's header", () => {
  it("carries the tokens of what is saved, and nothing when there are none", () => {
    expect(stampHeaders([])).toEqual({});
    expect(stampHeaders([null, undefined, ""])).toEqual({});
    expect(stampHeaders(["st1.a.b", null, "st1.c.d"])).toEqual({ [STAMP_HEADER]: "st1.a.b,st1.c.d" });
    const req = new Request("https://app.example.com/save", { headers: { [STAMP_HEADER]: "st1.a.b, st1.c.d,," } });
    expect(tokensFromRequest(req)).toEqual(["st1.a.b", "st1.c.d"]);
    expect(tokensFromRequest(new Request("https://app.example.com/save"))).toEqual([]);
  });
});
