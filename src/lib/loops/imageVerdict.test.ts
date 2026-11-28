import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listOpenAgentActions } from "@/lib/ontology/agentActions";
import { loopDayId, readLoopDays, runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { appendPatternVersionTx } from "@/lib/tenant/patternVersions";
import type { LearnedPatternVersion } from "@/lib/types/learnedPatternVersion";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { VersionTotalsSchema, type BrandPointers, type VersionTotals } from "@/lib/types/loopDay";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { keepLook, undoLook } from "./actions";
import { GO_BACK_ACTION, goBackReviewItem, learnedReviewItems } from "./cards";
import { newVerdictRun, readVersionVerdict, runImageVerdicts, seenOf, verdictDue } from "./imageVerdict";
import { holdStateOf, isHolding } from "./learners/votes";
import { madeIdOf } from "./stamp";

/**
 * The verdict for image looks (learning loops step 4, 3.8): Lumen's Illustration look version 2,
 * learned 9 Mar, against version 1, read at 40 a side; holdback and "Use learned brand style" off
 * left out; a Go back card on worse and never on too few; the run's budget.
 */

const lumen: TenantContext = { tenantId: "ten_lumen", region: "eu", source: "system", role: "admin", userId: "usr_priya" };
const ILLUSTRATION = "image_style.illustration";
const SOFT_3D = "image_style.soft_3d";
const DAY = 86_400_000;
const V1_AT = "2027-01-02T09:00:00.000Z";
const V2_AT = "2027-03-09T09:00:00.000Z";
const NOW = new Date("2027-05-10T09:00:00.000Z");

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

const stamp = (scope: string, v: number, arm: "learned" | "holdback" | "none", sources?: string[]): LoopStamp => ({
  made: madeIdOf(scope, v, arm),
  kind: "post_image",
  scope,
  v,
  arm,
  items: [],
  prompt: null,
  tokens: { rules: 0, examples: 0 },
  ...(sources ? { sources } : {}),
  at: V1_AT,
});

let seq = 0;
/** Whether output `i` of `n` is one of `hits`, spread evenly through them. */
const spread = (i: number, hits: number, n: number) => Math.floor(((i + 1) * hits) / n) > Math.floor((i * hits) / n);

/** Images of a style made one a day from `from`: `liked` of them liked, `remade` remade, spread out, every one voted the next day. */
function images(style: string, scope: string, v: number, from: string, n: number, opts: { liked: number; remade: number; arm?: "learned" | "holdback" | "none"; sources?: string[] }) {
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.parse(from) + i * DAY + 3_600_000);
    const id = `img_${String(++seq).padStart(4, "0")}`;
    db.seed("image_assets", id, {
      tenantId: lumen.tenantId,
      workspaceId: "ws_lumen",
      filename: `${id}.png`,
      mimeType: "image/png",
      kind: "social",
      style,
      createdAt: at.toISOString(),
      brandVote: spread(i, opts.liked, n) ? "up" : "down",
      firstVotedAt: new Date(at.getTime() + DAY).toISOString(),
      remadeAt: spread(i, opts.remade, n) ? new Date(at.getTime() + 2 * DAY).toISOString() : null,
      made: stamp(scope, v, opts.arm ?? "learned", opts.sources),
    });
  }
}

async function pointTo(scopes: BrandPointers["scopes"]) {
  await runLoopsTransaction(
    lumen,
    async (txn) => {
      for (const [scope, p] of Object.entries(scopes)) {
        for (let v = 1; v <= p.v; v++) {
          appendPatternVersionTx(
            txn,
            lumen,
            {
              channel: scope,
              version: v,
              directive: null,
              perform: [],
              avoid: [],
              judgeRationale: "",
              evidence: [],
              createdBy: v === p.v && p.setBy === "seeded" ? "seed" : "auto",
              createdAt: v === p.v ? p.adoptedAt : V1_AT,
              loop: "image_style",
              setBy: v === p.v ? p.setBy : "learned",
              items: [{ id: `look${v}`, type: "rule", text: `Look ${v} for ${scope}.`, trust: "own_content", from: "votes" }],
              change: { op: "add", itemId: `look${v}` },
              evidenceCounts: { liked: 20, disliked: 8, newestAt: "2027-03-08T09:00:00.000Z" },
            },
            db,
          );
        }
      }
      writeBrandPointersTx(txn, lumen, { scopes, seededAt: V1_AT }, db);
    },
    db,
  );
}

/** Lumen's Illustration: version 1 liked 30 of 40 and remade 4; version 2 liked 20 of 40 and remade 20. */
async function illustration() {
  images("illustration", ILLUSTRATION, 0, "2026-12-10T00:00:00.000Z", 12, { liked: 6, remade: 1, arm: "none" });
  images("illustration", ILLUSTRATION, 1, "2027-01-05T00:00:00.000Z", 40, { liked: 30, remade: 4 });
  images("illustration", ILLUSTRATION, 2, "2027-03-10T00:00:00.000Z", 40, { liked: 20, remade: 20 });
  // Left out: held back images, "Use learned brand style" off, customised images and other styles.
  images("illustration", ILLUSTRATION, 2, "2027-03-10T00:00:00.000Z", 6, { liked: 0, remade: 6, arm: "holdback" });
  images("illustration", ILLUSTRATION, 2, "2027-03-10T00:00:00.000Z", 6, { liked: 0, remade: 6, arm: "none", sources: ["person_off"] });
  images("editorial_photo", "image_style.editorial_photo", 0, "2027-03-10T00:00:00.000Z", 6, { liked: 0, remade: 6, arm: "none" });
  await pointTo({ [ILLUSTRATION]: { v: 2, setBy: "learned", adoptedAt: V2_AT } });
}

const totals = (c: VersionTotals["c"] = { post_image: { learned: { made: 40, voted: 40 } } }): VersionTotals => ({ c });

describe("runImageVerdicts", () => {
  it("reads worse on remakes at 40 a side, keeps the read on lv:, and offers to go back", async () => {
    await illustration();
    const run = newVerdictRun();
    const r = await runImageVerdicts(lumen, { scopes: { [ILLUSTRATION]: { v: 2, setBy: "learned", adoptedAt: V2_AT } }, seededAt: V1_AT }, { [ILLUSTRATION]: totals() }, run, { db, now: NOW });
    expect(r.verdicts).toHaveLength(1);
    const v = r.verdicts[0]!;
    expect(v.read).toMatchObject({ call: "worse", decidedBy: "guard", look: 40 });
    expect(v.read.guard).toEqual({ before: { hits: 4, n: 40 }, after: { hits: 20, n: 40 } });
    expect(v.read.check).toEqual({ before: { hits: 30, n: 40 }, after: { hits: 20, n: 40 } });
    expect(v.card).toBe("proposed");
    expect(run.readsLeft).toBe(0);

    const [lv] = await readLoopDays(lumen, [loopDayId.version(lumen.tenantId, ILLUSTRATION, 2)], db);
    const kept = VersionTotalsSchema.parse(lv?.d);
    expect(kept.looks?.["40"]?.call).toBe("worse");
    expect(kept.check).toMatchObject({ counted: 40, settled: true, seen: 80, pending: false });
    expect(kept.card?.look).toBe(40);

    const open = await listOpenAgentActions(lumen, { action: GO_BACK_ACTION, now: NOW.toISOString(), db });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ agent: "learning", target: { type: "learned_item", id: `${ILLUSTRATION}.v2` }, proposal: { scope: ILLUSTRATION, from: 2, to: 1 } });
    expect(JSON.stringify(open[0]!.proposal)).not.toContain("Look 2");

    const item = goBackReviewItem(open[0]!, "admin");
    expect(item).toMatchObject({ kind: "learned", title: "Go back to the earlier Illustration look?" });
    expect(item!.details).toEqual([
      "Your images were remade more since 9 Mar: 20 of 40 against 4 of 40 before.",
      "Not adjusted for season.",
      "The newer look came from 20 images you liked and 8 you didn't, newest 8 Mar.",
    ]);
    for (const line of item!.details!) expect([...dashesIn(line), ...aiTellsIn(line)]).toEqual([]);
    expect(goBackReviewItem(open[0]!, "member")!.details).toContain("Only admins can go back or keep a look.");
    expect(await learnedReviewItems({ ...lumen, role: "member" }, { db, now: NOW })).toHaveLength(1);
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    expect(await learnedReviewItems(lumen, { db, now: NOW })).toEqual([]);
  });

  it("never offers a card on too few, nor on a look a person set, nor past the weekly budget", async () => {
    images("soft_3d", SOFT_3D, 1, "2027-01-05T00:00:00.000Z", 20, { liked: 8, remade: 2 });
    images("soft_3d", SOFT_3D, 2, "2027-03-10T00:00:00.000Z", 20, { liked: 12, remade: 2 });
    await pointTo({ [SOFT_3D]: { v: 2, setBy: "learned", adoptedAt: V2_AT } });
    const r = await runImageVerdicts(lumen, { scopes: { [SOFT_3D]: { v: 2, setBy: "learned", adoptedAt: V2_AT } }, seededAt: V1_AT }, { [SOFT_3D]: totals() }, newVerdictRun(), { db, now: NOW });
    expect(r.verdicts[0]!.read.call).toBe("too_few");
    expect(r.verdicts[0]!.card).toBeUndefined();

    await illustration();
    const set = await runImageVerdicts(lumen, { scopes: { [ILLUSTRATION]: { v: 2, setBy: "person", adoptedAt: V2_AT } }, seededAt: V1_AT }, { [ILLUSTRATION]: totals() }, newVerdictRun(), { db, now: NOW });
    expect(set.verdicts[0]!.read.call).toBe("worse");
    expect(set.verdicts[0]!.card).toBeUndefined();

    const week = await runImageVerdicts(lumen, { scopes: { [ILLUSTRATION]: { v: 2, setBy: "learned", adoptedAt: V2_AT } }, seededAt: V1_AT }, { [ILLUSTRATION]: totals() }, newVerdictRun(), { db, now: NOW, proposedThisWeek: 1 });
    expect(week.verdicts[0]!.card).toBe("week");
    expect(await listOpenAgentActions(lumen, { action: GO_BACK_ACTION, now: NOW.toISOString(), db })).toEqual([]);
  });

  it("leaves a worse read to the card's own notice under the attention rule", async () => {
    await illustration();
    const r = await runImageVerdicts(lumen, { scopes: { [ILLUSTRATION]: { v: 2, setBy: "learned", adoptedAt: V2_AT } }, seededAt: V1_AT }, { [ILLUSTRATION]: totals() }, newVerdictRun(), {
      db,
      now: NOW,
      noticeOnly: async () => true,
    });
    expect(r.verdicts[0]!.card).toBe("notice");
    expect(await listOpenAgentActions(lumen, { action: GO_BACK_ACTION, now: NOW.toISOString(), db })).toEqual([]);
  });

  it("reads a carried over version as having nothing before it, and its images from the seed on", async () => {
    legacy("illustration", "2026-11-01T00:00:00.000Z", 30);
    images("illustration", ILLUSTRATION, 1, "2027-01-05T00:00:00.000Z", 30, { liked: 20, remade: 1 });
    await pointTo({ [ILLUSTRATION]: { v: 1, setBy: "seeded", adoptedAt: V1_AT } });
    const r = await runImageVerdicts(lumen, { scopes: { [ILLUSTRATION]: { v: 1, setBy: "seeded", adoptedAt: V1_AT } }, seededAt: V1_AT }, { [ILLUSTRATION]: totals() }, newVerdictRun(), { db, now: NOW });
    expect(r.verdicts[0]!.read).toMatchObject({ call: "too_few", usableBefore: 0, after: 30 });
    expect(r.verdicts[0]!.check).toMatchObject({ settled: true, counted: 20 });
  });

  it("keeps to the run's budget, one version a run, and reads again only once its counters move", async () => {
    await illustration();
    images("soft_3d", SOFT_3D, 2, "2027-03-10T00:00:00.000Z", 10, { liked: 5, remade: 1 });
    const pointers: BrandPointers = { scopes: { [ILLUSTRATION]: { v: 2, setBy: "learned", adoptedAt: V2_AT }, [SOFT_3D]: { v: 2, setBy: "learned", adoptedAt: V2_AT } }, seededAt: V1_AT };
    const run = newVerdictRun();
    const r = await runImageVerdicts(lumen, pointers, { [ILLUSTRATION]: totals(), [SOFT_3D]: totals() }, run, { db, now: NOW });
    expect(r.verdicts.map((v) => v.scope)).toEqual([ILLUSTRATION]);
    expect(r.deferred).toBe(true);

    const [lv] = await readLoopDays(lumen, [loopDayId.version(lumen.tenantId, ILLUSTRATION, 2)], db);
    const kept = VersionTotalsSchema.parse(lv?.d);
    const same = { ...totals(), check: kept.check };
    expect(verdictDue(same, new Date(NOW.getTime() + 2 * DAY)).due).toBe(false);
    const moved = { ...totals({ post_image: { learned: { made: 41, voted: 40 } } }), check: kept.check };
    expect(seenOf(moved)).toBe(81);
    expect(verdictDue(moved, new Date(NOW.getTime() + 3_600_000)).due).toBe(false);
    expect(verdictDue(moved, new Date(NOW.getTime() + DAY + 1)).due).toBe(true);
  });
});

/** Images from before versions: voted, but with no stamp, no first vote time and no remake kept. */
function legacy(style: string, from: string, n: number, stepMs = DAY) {
  for (let i = 0; i < n; i++) {
    const id = `old_${String(++seq).padStart(4, "0")}`;
    db.seed("image_assets", id, {
      tenantId: lumen.tenantId,
      workspaceId: "ws_lumen",
      filename: `${id}.png`,
      mimeType: "image/png",
      kind: "social",
      style,
      createdAt: new Date(Date.parse(from) + i * stepMs).toISOString(),
      brandVote: i % 2 ? "up" : "down",
    });
  }
}

/** Version rows of one scope, as given, and the pointer to the last. */
async function versionRows(scope: string, rows: Array<Partial<LearnedPatternVersion> & { v: number; at: string }>, pointer: BrandPointers["scopes"][string]) {
  await runLoopsTransaction(
    lumen,
    async (txn) => {
      for (const r of rows) {
        appendPatternVersionTx(
          txn,
          lumen,
          {
            channel: scope,
            version: r.v,
            directive: null,
            perform: [],
            avoid: [],
            judgeRationale: "",
            evidence: [],
            createdBy: r.createdBy ?? "auto",
            createdAt: r.at,
            loop: "image_style",
            setBy: r.setBy ?? "learned",
            items: r.items ?? [{ id: `look${r.v}`, type: "rule", text: `Look ${r.v} for ${scope}.`, trust: "own_content", from: "votes" }],
            change: { op: "add", itemId: `look${r.v}` },
          },
          db,
        );
      }
      writeBrandPointersTx(txn, lumen, { scopes: { [scope]: pointer! }, seededAt: "2026-12-01T00:00:00.000Z" }, db);
    },
    db,
  );
}

const pointersOf = async (): Promise<BrandPointers> => {
  const { readBrandPointers } = await import("@/lib/tenant/loops");
  return readBrandPointers(lumen, db);
};

describe("which images a version reads (review round 1)", () => {
  const NATURAL = "image_style.natural_photo";
  const BRAND = "image_style.brand";

  it("reads a carried over look's images from the seed on, however many older images the brand has, so its hold can end", async () => {
    const SEED_AT = "2027-01-01T00:00:00.000Z";
    // 520 images from before versions, then 60 made with the carried over look.
    legacy("natural_photo", "2026-08-01T00:00:00.000Z", 520, DAY / 4);
    images("natural_photo", NATURAL, 1, "2027-01-02T00:00:00.000Z", 60, { liked: 40, remade: 5 });
    await versionRows(NATURAL, [{ v: 1, at: SEED_AT, setBy: "seeded", createdBy: "seed" }], { v: 1, setBy: "seeded", adoptedAt: SEED_AT });
    const t = totals({ post_image: { learned: { made: 60, voted: 60, liked: 40 } } });
    const r = await runImageVerdicts(lumen, await pointersOf(), { [NATURAL]: t }, newVerdictRun(), { db, now: NOW });
    const v = r.verdicts[0]!;
    expect(v.read.after).toBe(60);
    // The scope's first 10 votes are its warm up; the other 50 count toward checking the next look.
    expect(v.check).toMatchObject({ counted: 50, settled: true });
    expect(isHolding(holdStateOf({ ...t, check: v.check }))).toBe(false);
  });

  it("leaves out images from before versions, which never had a remake kept, so equal remake rates never read worse", async () => {
    const V2 = "2027-02-01T00:00:00.000Z";
    legacy("natural_photo", "2026-06-01T00:00:00.000Z", 100);
    // Under the carried over look and then version 2: half remade under each.
    images("natural_photo", NATURAL, 1, "2027-01-05T00:00:00.000Z", 20, { liked: 10, remade: 10 });
    images("natural_photo", NATURAL, 2, "2027-02-02T00:00:00.000Z", 80, { liked: 40, remade: 40 });
    const got = await readVersionVerdict(lumen, { scope: NATURAL, v: 2, adoptedAt: V2, prevAdoptedAt: null, seen: 0 }, { db, now: NOW });
    expect(got.read.call).not.toBe("worse");
    expect(got.read.guard?.before.n ?? 0).toBeLessThanOrEqual(20);
  });

  it("gives the brand look the images stamped with it, whatever style they were painted in, so its check counts and its hold ends", async () => {
    const V1 = "2027-01-01T00:00:00.000Z";
    const V2 = "2027-03-01T00:00:00.000Z";
    // Natural photo and Product still life have no look of their own: their images use the brand look.
    images("natural_photo", BRAND, 1, "2027-01-02T00:00:00.000Z", 40, { liked: 30, remade: 2 });
    images("product_still_life", BRAND, 2, "2027-03-02T00:00:00.000Z", 40, { liked: 30, remade: 2 });
    await versionRows(BRAND, [{ v: 1, at: V1 }, { v: 2, at: V2 }], { v: 2, setBy: "learned", adoptedAt: V2 });
    const t = totals({ post_image: { learned: { made: 40, voted: 40, liked: 30 } } });
    const r = await runImageVerdicts(lumen, await pointersOf(), { [BRAND]: t }, newVerdictRun(), { db, now: NOW });
    const v = r.verdicts[0]!;
    expect(v.read.after).toBe(40);
    expect(v.read.check?.after.n).toBeGreaterThan(0);
    expect(v.check.counted).toBe(40);
    expect(isHolding(holdStateOf({ ...t, check: v.check }))).toBe(false);
  });

  it("reads a style's first look against the style's images made with the brand look before it", async () => {
    const V1 = "2027-03-01T00:00:00.000Z";
    images("natural_photo", BRAND, 1, "2027-01-02T00:00:00.000Z", 40, { liked: 30, remade: 2 });
    images("natural_photo", NATURAL, 1, "2027-03-02T00:00:00.000Z", 40, { liked: 30, remade: 2 });
    // Made with the brand look after Natural photo's own began: not Natural photo's own outputs.
    images("natural_photo", BRAND, 1, "2027-03-02T00:00:00.000Z", 5, { liked: 0, remade: 5 });
    await versionRows(NATURAL, [{ v: 1, at: V1 }], { v: 1, setBy: "learned", adoptedAt: V1 });
    const r = await runImageVerdicts(lumen, await pointersOf(), { [NATURAL]: totals() }, newVerdictRun(), { db, now: NOW });
    expect(r.verdicts[0]!.read).toMatchObject({ usableBefore: 30, after: 40 });
  });

  it("offers no Go back card on a Forget's version, nor back to a look whose words a Forget took out", async () => {
    const V1 = "2027-01-01T00:00:00.000Z";
    const FORGOT = "2027-02-15T00:00:00.000Z";
    // The scope's warm up, spent before its first look.
    images("natural_photo", NATURAL, 0, "2026-11-01T00:00:00.000Z", 20, { liked: 10, remade: 2, arm: "none" });
    images("natural_photo", NATURAL, 1, "2027-01-02T00:00:00.000Z", 40, { liked: 34, remade: 4 });
    images("natural_photo", NATURAL, 2, "2027-02-16T00:00:00.000Z", 40, { liked: 14, remade: 4, arm: "none" });
    await versionRows(NATURAL, [{ v: 1, at: V1, items: [{ id: "look1", type: "rule", text: null, trust: "own_content", from: "votes" }] }, { v: 2, at: FORGOT, createdBy: "forget", items: [] }], { v: 2, setBy: "learned", adoptedAt: FORGOT });
    const r = await runImageVerdicts(lumen, await pointersOf(), { [NATURAL]: totals() }, newVerdictRun(), { db, now: NOW });
    expect(r.verdicts[0]!.read.call).toBe("worse");
    expect(r.verdicts[0]!.card).toBeUndefined();

    // A learned look after it reads worse, but the look before it can't come back: no card either.
    db = new FakeFirestore();
    images("natural_photo", NATURAL, 0, "2026-11-01T00:00:00.000Z", 20, { liked: 10, remade: 2, arm: "none" });
    images("natural_photo", NATURAL, 1, "2027-01-02T00:00:00.000Z", 40, { liked: 34, remade: 4 });
    images("natural_photo", NATURAL, 2, "2027-02-16T00:00:00.000Z", 40, { liked: 14, remade: 4 });
    await versionRows(NATURAL, [{ v: 1, at: V1, items: [{ id: "look1", type: "rule", text: null, trust: "own_content", from: "votes" }] }, { v: 2, at: FORGOT }], { v: 2, setBy: "learned", adoptedAt: FORGOT });
    const s = await runImageVerdicts(lumen, await pointersOf(), { [NATURAL]: totals() }, newVerdictRun(), { db, now: NOW });
    expect(s.verdicts[0]!.read.call).toBe("worse");
    expect(s.verdicts[0]!.card).toBeUndefined();
    expect(await listOpenAgentActions(lumen, { action: GO_BACK_ACTION, now: NOW.toISOString(), db })).toEqual([]);
  });

  it("reads an Undo back to the carried over look as a version of its own, from the Undo on", async () => {
    const SEED_AT = "2027-01-01T00:00:00.000Z";
    const V2 = "2027-02-01T00:00:00.000Z";
    images("natural_photo", NATURAL, 1, "2027-01-02T00:00:00.000Z", 25, { liked: 20, remade: 2 });
    images("natural_photo", NATURAL, 2, "2027-02-02T00:00:00.000Z", 30, { liked: 6, remade: 2 });
    await versionRows(NATURAL, [{ v: 1, at: SEED_AT, setBy: "seeded", createdBy: "seed" }, { v: 2, at: V2 }], { v: 2, setBy: "learned", adoptedAt: V2 });
    const undone = await undoLook(lumen, NATURAL, { db, now: new Date("2027-04-01T00:00:00.000Z") });
    expect(undone).toMatchObject({ ok: true, v: 3 });
    const pointers = await pointersOf();
    expect(pointers.scopes[NATURAL]).toMatchObject({ v: 3, setBy: "seeded" });
    // Nothing made since the Undo: version 3 has no outputs yet, and none of version 2's count as its own.
    const r = await runImageVerdicts(lumen, pointers, { [NATURAL]: { c: {} } }, newVerdictRun(), { db, now: new Date("2027-04-02T00:00:00.000Z") });
    expect(r.verdicts[0]!.read.after).toBe(0);
    expect(r.verdicts[0]!.check.counted).toBe(0);
  });

  it("offers no card for a look kept from the card's own notice, at that read", async () => {
    await illustration();
    const first = await runImageVerdicts(lumen, await pointersOf(), { [ILLUSTRATION]: totals() }, newVerdictRun(), { db, now: NOW, noticeOnly: async () => true });
    expect(first.verdicts[0]).toMatchObject({ card: "notice", read: { call: "worse", look: 40 } });
    expect(await keepLook(lumen, { scope: ILLUSTRATION }, { db, now: NOW })).toEqual({ ok: true, v: 2 });
    const pointers = await pointersOf();
    expect(pointers.scopes[ILLUSTRATION]).toMatchObject({ keptAt: NOW.toISOString(), keptLook: 40 });
    // Cards come back (Resume suggestions): the same read at the same look offers nothing.
    const later = new Date(NOW.getTime() + 2 * DAY);
    const second = await runImageVerdicts(lumen, pointers, { [ILLUSTRATION]: totals({ post_image: { learned: { made: 41, voted: 40 } } }) }, newVerdictRun(), { db, now: later, noticeOnly: async () => false });
    expect(second.verdicts[0]!.read).toMatchObject({ call: "worse", look: 40 });
    expect(second.verdicts[0]!.card).toBeUndefined();
    expect(await listOpenAgentActions(lumen, { action: GO_BACK_ACTION, now: later.toISOString(), db })).toEqual([]);
  });
});

describe("which images a version reads (review round 2)", () => {
  const BRAND = "image_style.brand";

  /** Rows made `stepMs` apart from `from`, each with the stamp and fields given. */
  function rows(prefix: string, from: string, n: number, stepMs: number, row: (i: number) => Record<string, unknown>) {
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.parse(from) + i * stepMs);
      const id = `${prefix}_${String(++seq).padStart(4, "0")}`;
      db.seed("image_assets", id, { tenantId: lumen.tenantId, workspaceId: "ws_lumen", filename: `${id}.png`, mimeType: "image/png", kind: "social", createdAt: at.toISOString(), ...row(i) });
    }
  }

  const lvOf = async (scope: string, v: number) => {
    const [lv] = await readLoopDays(lumen, [loopDayId.version(lumen.tenantId, scope, v)], db);
    return VersionTotalsSchema.parse(lv?.d ?? {});
  };

  it("pages its images since it began across visits, so a style behind 500 of another's still reaches its outputs", async () => {
    images("illustration", ILLUSTRATION, 0, "2026-12-10T00:00:00.000Z", 12, { liked: 6, remade: 1, arm: "none" });
    images("illustration", ILLUSTRATION, 1, "2027-01-05T00:00:00.000Z", 40, { liked: 30, remade: 4 });
    // 500 Soft 3D images in the hours after version 2 began, then version 2's own.
    rows("soft", "2027-03-09T09:01:00.000Z", 500, 60_000, () => ({ style: "soft_3d", brandVote: "up", firstVotedAt: "2027-03-10T09:00:00.000Z", made: stamp(SOFT_3D, 1, "learned") }));
    images("illustration", ILLUSTRATION, 2, "2027-03-10T00:00:00.000Z", 40, { liked: 30, remade: 4 });
    await pointTo({ [ILLUSTRATION]: { v: 2, setBy: "learned", adoptedAt: V2_AT } });
    const pointers = await pointersOf();
    const t = totals({ post_image: { learned: { made: 40, voted: 40, liked: 30 } } });

    const first = await runImageVerdicts(lumen, pointers, { [ILLUSTRATION]: t }, newVerdictRun(), { db, now: NOW });
    expect(first.verdicts[0]!.read.after).toBe(0);
    expect(first.verdicts[0]!.check.more).toBe(true);
    // The next visit is full, and the version is due on it whatever its counters.
    expect(first.dueAt).toBe(NOW.toISOString());
    const kept = await lvOf(ILLUSTRATION, 2);
    expect(kept.after).toMatchObject({ from: V2_AT, votes: 0, check: "" });
    expect(verdictDue({ ...t, check: kept.check, after: kept.after }, new Date(NOW.getTime() + 60_000)).due).toBe(true);

    const later = new Date(NOW.getTime() + 600_000);
    const second = await runImageVerdicts(lumen, pointers, { [ILLUSTRATION]: { ...t, check: kept.check, after: kept.after } }, newVerdictRun(), { db, now: later });
    const v = second.verdicts[0]!;
    expect(v.read.after).toBe(40);
    expect(v.check).toMatchObject({ counted: 40 });
    expect(v.check.more).toBeUndefined();
    expect(isHolding(holdStateOf({ ...t, check: v.check }))).toBe(false);
    const after = (await lvOf(ILLUSTRATION, 2)).after!;
    expect(after.check).toHaveLength(40);
    expect([...after.check].filter((b) => b === "1")).toHaveLength(30);
    expect((await lvOf(ILLUSTRATION, 2)).check?.more).toBe(false);

    // A third visit reads on from the cursor: nothing new, so the same entries and no image counted twice.
    const third = await runImageVerdicts(lumen, pointers, { [ILLUSTRATION]: { ...t, check: undefined, after } }, newVerdictRun(), { db, now: new Date(later.getTime() + DAY + 1) });
    expect(third.verdicts[0]!.read.after).toBe(40);
  });

  it("reads on from images too new at the last read once they are 14 days old, never counting one twice", async () => {
    images("illustration", ILLUSTRATION, 1, "2027-01-05T00:00:00.000Z", 40, { liked: 30, remade: 4 });
    images("illustration", ILLUSTRATION, 2, "2027-03-10T00:00:00.000Z", 20, { liked: 15, remade: 2 });
    await pointTo({ [ILLUSTRATION]: { v: 2, setBy: "learned", adoptedAt: V2_AT } });
    // On 5 Apr only the 12 images made by 21 Mar are 14 days old.
    const early = await readVersionVerdict(lumen, { scope: ILLUSTRATION, v: 2, adoptedAt: V2_AT, prevAdoptedAt: V1_AT, seen: 0 }, { db, now: new Date("2027-04-05T00:00:00.000Z") });
    expect(early.after.votes).toBe(12);
    expect(early.check.pending).toBe(true);
    const late = await readVersionVerdict(lumen, { scope: ILLUSTRATION, v: 2, adoptedAt: V2_AT, prevAdoptedAt: V1_AT, seen: 0, after: early.after }, { db, now: NOW });
    expect(late.after.votes).toBe(20);
    expect(late.after.guard).toHaveLength(20);
    expect(late.check.pending).toBe(false);
    // A different start reads afresh.
    const moved = await readVersionVerdict(lumen, { scope: ILLUSTRATION, v: 2, adoptedAt: "2027-03-20T00:00:00.000Z", prevAdoptedAt: V1_AT, seen: 0, after: late.after }, { db, now: NOW });
    expect(moved.after.votes).toBeLessThan(20);
    expect(moved.after.from).toBe("2027-03-20T00:00:00.000Z");
  });

  it("leaves out images its look never reached: arm none on a version with a look, a drawn fallback, a path that never learns", async () => {
    images("illustration", ILLUSTRATION, 0, "2026-12-10T00:00:00.000Z", 12, { liked: 6, remade: 1, arm: "none" });
    images("illustration", ILLUSTRATION, 1, "2027-01-05T00:00:00.000Z", 40, { liked: 30, remade: 4 });
    images("illustration", ILLUSTRATION, 2, "2027-03-10T00:00:00.000Z", 40, { liked: 30, remade: 4 });
    await pointTo({ [ILLUSTRATION]: { v: 2, setBy: "learned", adoptedAt: V2_AT } });
    const input = { scope: ILLUSTRATION, v: 2, adoptedAt: V2_AT, prevAdoptedAt: V1_AT, seen: 0 };
    const clean = await readVersionVerdict(lumen, input, { db, now: NOW });
    // eBook edits and format cards (not_learning), a look that stayed out of the prompt (arm none),
    // and another version's images: none liked, all remade.
    images("illustration", ILLUSTRATION, 2, "2027-03-10T00:00:00.000Z", 20, { liked: 0, remade: 20, arm: "none", sources: ["not_learning"] });
    images("illustration", ILLUSTRATION, 2, "2027-03-10T00:00:00.000Z", 20, { liked: 0, remade: 20, arm: "none" });
    images("illustration", ILLUSTRATION, 1, "2027-03-10T00:00:00.000Z", 20, { liked: 0, remade: 20 });
    // Before the change, title cards and format cards drawn in the style aren't the old look's outputs either.
    images("illustration", ILLUSTRATION, 1, "2027-01-05T00:00:00.000Z", 20, { liked: 20, remade: 0, arm: "none", sources: ["fallback_drawn"] });
    images("illustration", ILLUSTRATION, 0, "2027-01-05T00:00:00.000Z", 20, { liked: 20, remade: 0, arm: "none", sources: ["not_learning"] });
    const mixed = await readVersionVerdict(lumen, input, { db, now: NOW });
    expect(mixed.read).toEqual(clean.read);
    expect(mixed.check.counted).toBe(clean.check.counted);
    // A version with no look of its own (a Forget's) keeps its arm none images too; never a path that never learns.
    const noLook = await readVersionVerdict(lumen, { ...input, hasLook: false }, { db, now: NOW });
    expect(noLook.after.votes).toBe(60);
  });

  it("never reads the brand look worse from title cards made at the image allowance, so offers no Go back card", async () => {
    const V1 = "2027-01-01T00:00:00.000Z";
    const V2 = "2027-03-01T00:00:00.000Z";
    images("natural_photo", BRAND, 1, "2027-01-02T00:00:00.000Z", 40, { liked: 30, remade: 2 });
    images("title_card", BRAND, 2, "2027-03-02T00:00:00.000Z", 40, { liked: 0, remade: 0, arm: "none", sources: ["fallback_drawn"] });
    await versionRows(BRAND, [{ v: 1, at: V1 }, { v: 2, at: V2 }], { v: 2, setBy: "learned", adoptedAt: V2 });
    const r = await runImageVerdicts(lumen, await pointersOf(), { [BRAND]: totals() }, newVerdictRun(), { db, now: NOW });
    expect(r.verdicts[0]!.read).toMatchObject({ call: "too_few", after: 0 });
    expect(r.verdicts[0]!.card).toBeUndefined();
    expect(await listOpenAgentActions(lumen, { action: GO_BACK_ACTION, now: NOW.toISOString(), db })).toEqual([]);
  });

  it("fixes each image's outcome at 14 days: a vote changed or cleared later moves nothing", async () => {
    images("illustration", ILLUSTRATION, 1, "2027-01-05T00:00:00.000Z", 40, { liked: 30, remade: 4 });
    const V2_FIRST = "2027-03-10T00:00:00.000Z";
    // Liked within 14 days; 10 changed to down and 10 cleared on day 30.
    rows("kept", V2_FIRST, 30, DAY, (i) => ({
      style: "illustration",
      brandVote: i < 10 ? "down" : i < 20 ? null : "up",
      outcomeVote: "up",
      firstVotedAt: new Date(Date.parse(V2_FIRST) + i * DAY + DAY).toISOString(),
      made: stamp(ILLUSTRATION, 2, "learned"),
    }));
    // Cleared within 14 days and voted again after: no entry.
    rows("late", "2027-04-09T00:00:00.000Z", 5, 3_600_000, () => ({ style: "illustration", brandVote: "up", outcomeVote: null, firstVotedAt: "2027-04-10T00:00:00.000Z", made: stamp(ILLUSTRATION, 2, "learned") }));
    await pointTo({ [ILLUSTRATION]: { v: 2, setBy: "learned", adoptedAt: V2_AT } });
    const got = await readVersionVerdict(lumen, { scope: ILLUSTRATION, v: 2, adoptedAt: V2_AT, prevAdoptedAt: V1_AT, seen: 0 }, { db, now: NOW });
    expect(got.after.votes).toBe(30);
    expect(got.after.check).toBe("1".repeat(30));
    expect(got.after.guard).toHaveLength(35);
  });
});
