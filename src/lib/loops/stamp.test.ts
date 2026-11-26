import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listPrompts } from "@/lib/agents/prompts/registry";
import { sourceFiles, stripComments } from "@/lib/ontology/storeScan";
import { LOOP_DAYS } from "@/lib/tenant/loops";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { madeIdOf, parseMadeId, promptStamp, settleStamp, signStamp, verifyStamp, type StampUse } from "./stamp";

/** Stamps (src/lib/loops/stamp.ts, learning loops step 4): made ids, the prompt part, settling, and the signed token. */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "idtoken" };
const lumen: TenantContext = { tenantId: "ten_lumen", region: "eu", source: "idtoken" };

const NOW = new Date("2026-12-01T10:00:00.000Z");
const DAY = 86_400_000;

const stamp = (over: Partial<LoopStamp> = {}): LoopStamp => ({
  made: "m1.image_style.natural_photo.1.l",
  kind: "post_image",
  scope: "image_style.natural_photo",
  v: 1,
  arm: "learned",
  items: ["look1"],
  prompt: null,
  tokens: { rules: 24, examples: 0 },
  at: NOW.toISOString(),
  ...over,
});

describe("made ids", () => {
  it("names a scope, a version and an arm, and no brand or person", () => {
    const id = madeIdOf("image_style.natural_photo", 3, "holdback");
    expect(id).toBe("m1.image_style.natural_photo.3.h");
    expect(id).not.toContain(hearth.tenantId);
    expect(parseMadeId(id)).toEqual({ scope: "image_style.natural_photo", v: 3, arm: "holdback", tail: null });
    expect(parseMadeId("m1.image_style.brand.0.n.k3x9q2")).toEqual({ scope: "image_style.brand", v: 0, arm: "none", tail: "k3x9q2" });
    expect(madeIdOf("image_style.brand", 2, "learned", "k3x9q2")).toBe("m1.image_style.brand.2.l.k3x9q2");
  });

  it("reads nothing that isn't one, and refuses to build one from a scope that can't be", () => {
    for (const bad of [null, 7, "", "m1.image_style.brand.1", "m1.Image_style.brand.1.l", "m2.image_style.brand.1.l", `m1.${"a".repeat(60)}.1.l`]) {
      expect(parseMadeId(bad), String(bad)).toBeNull();
    }
    expect(() => madeIdOf("image style", 1, "learned")).toThrow();
    expect(() => madeIdOf("ten_hearth:image_style", 1, "learned")).toThrow();
  });
});

describe("promptStamp", () => {
  it("gives every registered prompt its id, version and a short hash of its template, within 80 characters", () => {
    for (const p of listPrompts()) {
      const s = promptStamp(p.id);
      expect(s, p.id).toMatch(new RegExp(`^${p.id.replace(/\./g, "\\.")}@${p.version}#[0-9a-f]{6}$`));
      expect(s!.length, p.id).toBeLessThanOrEqual(80);
    }
    expect(promptStamp("content.style_profile_synthesize")).toBe(promptStamp("content.style_profile_synthesize"));
    expect(promptStamp("content.style_profile_synthesize")).not.toBe(promptStamp("content.brand_fit_judge"));
  });

  it("is null for a prompt the registry doesn't know", () => {
    expect(promptStamp("content.not_a_prompt")).toBeNull();
  });
});

describe("settleStamp", () => {
  const legacy = stamp({ made: "m1.image_style.natural_photo.0.n", v: 0, arm: "none", items: [], sources: ["legacy"] });
  const off = stamp({ made: "m1.image_style.natural_photo.1.n", arm: "none", items: [], tokens: { rules: 0, examples: 0 }, sources: ["person_off"] });
  const held = stamp({ made: "m1.image_style.natural_photo.1.h", arm: "holdback", items: [], tokens: { rules: 0, examples: 0 } });
  const cases: Array<[string, LoopStamp, StampUse, { arm: LoopStamp["arm"]; sources?: string[]; items: string[]; rules: number }]> = [
    ["learned, the look reached the prompt", stamp(), { lookUsed: true }, { arm: "learned", items: ["look1"], rules: 24 }],
    ["learned, the look stayed out", stamp(), { lookUsed: false }, { arm: "none", items: [], rules: 0 }],
    ["learned, with style references and best of 3", stamp(), { lookUsed: true, refs: 3, bestOf: 3 }, { arm: "learned", sources: ["refs:3", "best_of:3"], items: ["look1"], rules: 24 }],
    ["learned, best of 1 adds nothing", stamp(), { lookUsed: true, refs: 0, bestOf: 1 }, { arm: "learned", items: ["look1"], rules: 24 }],
    ["learned, then a drawn fallback", stamp(), { lookUsed: false, fallbackDrawn: true }, { arm: "none", sources: ["fallback_drawn"], items: [], rules: 0 }],
    ["learned, then the painted twin after a drawn render failed", stamp(), { lookUsed: true, refs: 2, fallbackDrawn: true }, { arm: "none", sources: ["refs:2", "fallback_drawn"], items: ["look1"], rules: 24 }],
    ["held back, the look stayed out", held, { lookUsed: false, bestOf: 2 }, { arm: "holdback", sources: ["best_of:2"], items: [], rules: 0 }],
    ["held back, yet a look reached the prompt", held, { lookUsed: true }, { arm: "none", items: [], rules: 0 }],
    ["the old field, before seeding", legacy, { lookUsed: true, refs: 4 }, { arm: "none", sources: ["legacy", "refs:4"], items: [], rules: 24 }],
    ["Use learned brand style off", off, { lookUsed: false }, { arm: "none", sources: ["person_off"], items: [], rules: 0 }],
    ["more references than a stamp counts", stamp(), { lookUsed: true, refs: 250 }, { arm: "learned", sources: ["refs:99"], items: ["look1"], rules: 24 }],
    ["learned, on a path that never learns (a format's card)", stamp(), { lookUsed: true, notLearning: true }, { arm: "none", items: ["look1"], rules: 24 }],
    ["held back, on a path that never learns (an edit)", held, { lookUsed: false, notLearning: true }, { arm: "none", items: [], rules: 0 }],
  ];

  it.each(cases)("%s", (_name, given, use, want) => {
    const settled = settleStamp(given, use) as LoopStamp;
    expect(settled.arm).toBe(want.arm);
    expect(settled.made).toBe(madeIdOf(given.scope, given.v, want.arm));
    expect(settled.sources).toEqual(want.sources);
    expect(settled.items).toEqual(want.items);
    expect(settled.tokens.rules).toBe(want.rules);
    expect(settled.v).toBe(given.v);
    expect(settled.scope).toBe(given.scope);
  });

  it("leaves a thing with no stamp as it was, and keeps a made id's tail", () => {
    expect(settleStamp({ unstamped: "image_versions_off" }, { lookUsed: true })).toEqual({ unstamped: "image_versions_off" });
    const tailed = settleStamp(stamp({ made: "m1.image_style.natural_photo.1.l.k3x9q2" }), { lookUsed: false }) as LoopStamp;
    expect(tailed.made).toBe("m1.image_style.natural_photo.1.n.k3x9q2");
  });
});

describe("the signed token", () => {
  const decode = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { s: LoopStamp; e: number };
  const encode = (token: string, payload: unknown) => {
    const [prefix, , sig] = token.split(".");
    return `${prefix}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
  };

  it("comes back as the same stamp within 7 days, and holds the stamp but never the key", async () => {
    const db = new FakeFirestore();
    const token = await signStamp(hearth, stamp(), { now: NOW, db });
    expect(await verifyStamp(hearth, token, { now: new Date(NOW.getTime() + 7 * DAY - 1), db })).toEqual({ ok: true, stamp: stamp() });
    const key = (db.raw(LOOP_DAYS, "lk:ten_hearth") as { d: { key: string } }).d.key;
    expect(key.length).toBeGreaterThanOrEqual(32);
    expect(token).not.toContain(key);
    expect(token).not.toContain(Buffer.from(key).toString("base64url"));
    expect(decode(token).s).toEqual(stamp());
  });

  it("is refused with any field changed, past its expiry, from another brand, or not a token at all", async () => {
    const db = new FakeFirestore();
    const token = await signStamp(hearth, stamp(), { now: NOW, db });
    const payload = decode(token);
    for (const changed of [
      { ...payload, s: { ...payload.s, arm: "holdback", made: "m1.image_style.natural_photo.1.h" } },
      { ...payload, s: { ...payload.s, v: 2, made: "m1.image_style.natural_photo.2.l" } },
      { ...payload, s: { ...payload.s, kind: "blog_hero" } },
      { ...payload, s: { ...payload.s, sources: ["person_off"] } },
      { ...payload, e: payload.e + 30 * DAY },
    ]) {
      expect(await verifyStamp(hearth, encode(token, changed), { now: NOW, db })).toEqual({ ok: false, reason: "signature" });
    }
    expect(await verifyStamp(hearth, token, { now: new Date(NOW.getTime() + 7 * DAY + 1), db })).toEqual({ ok: false, reason: "expired" });
    expect(await verifyStamp(lumen, token, { now: NOW, db })).toEqual({ ok: false, reason: "signature" });
    for (const bad of [undefined, 42, "", "st1.abc", "st2.abc.def", `st1.${"a".repeat(3000)}.b`, "st1..sig"]) {
      expect(await verifyStamp(hearth, bad, { now: NOW, db }), String(bad).slice(0, 20)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses to sign a stamp that isn't one", async () => {
    const db = new FakeFirestore();
    await expect(signStamp(hearth, stamp({ made: "m1.image_style.brand.1.l" }), { now: NOW, db })).rejects.toThrow();
  });

  it("is signed with one key per brand, minted once", async () => {
    const db = new FakeFirestore();
    const [a, b] = await Promise.all([signStamp(hearth, stamp(), { now: NOW, db }), signStamp(hearth, stamp(), { now: NOW, db })]);
    expect(a).toBe(b);
    expect(await verifyStamp(hearth, a, { now: NOW, db })).toMatchObject({ ok: true });
    expect(db.raw(LOOP_DAYS, "lk:ten_lumen")).toBeUndefined();
  });
});

describe("the stamp key stays in stamp.ts", () => {
  const ROOT = process.cwd();
  const ALLOWED = new Set(["src/lib/loops/stamp.ts", "src/lib/tenant/loops.ts"]);
  const KEY_READ = /\bstampKeyFor\b|\bloopDayId\.key\b|\bLOOP_DOC_PREFIXES\.key\b|["'`]lk:/;

  it("is read only by src/lib/loops/stamp.ts, through the store that mints it", () => {
    const readers = sourceFiles("src", ROOT).filter((f) => KEY_READ.test(stripComments(readFileSync(join(ROOT, f), "utf8"))));
    expect(readers.sort()).toEqual([...ALLOWED].sort());
    const outside = stripComments(readFileSync(join(ROOT, "src/lib/tenant/loops.ts"), "utf8"));
    expect(outside.match(/\bstampKeyFor\(/g)?.length, "only stampKeyFor's own definition").toBe(1);
  });

  it("is never handed back: stamp.ts exports nothing that returns it", async () => {
    const mod = await import("./stamp");
    expect(Object.keys(mod).sort()).toEqual(["STAMP_REFUSALS", "madeIdOf", "parseMadeId", "promptStamp", "settleStamp", "signStamp", "verifyStamp"]);
  });
});
