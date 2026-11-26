import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listOpenAgentActions } from "@/lib/ontology/agentActions";
import { loopDayId, readLoopDays, runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { appendPatternVersionTx } from "@/lib/tenant/patternVersions";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { VersionTotalsSchema, type BrandPointers, type VersionTotals } from "@/lib/types/loopDay";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { GO_BACK_ACTION, goBackReviewItem, learnedReviewItems } from "./cards";
import { newVerdictRun, runImageVerdicts, seenOf, verdictDue } from "./imageVerdict";
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
              createdBy: "auto",
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

  it("reads a carried over version as having nothing before it", async () => {
    images("illustration", ILLUSTRATION, 1, "2026-11-01T00:00:00.000Z", 30, { liked: 20, remade: 1, arm: "none" });
    await pointTo({ [ILLUSTRATION]: { v: 1, setBy: "seeded", adoptedAt: V1_AT } });
    const r = await runImageVerdicts(lumen, { scopes: { [ILLUSTRATION]: { v: 1, setBy: "seeded", adoptedAt: V1_AT } }, seededAt: V1_AT }, { [ILLUSTRATION]: totals() }, newVerdictRun(), { db, now: NOW });
    expect(r.verdicts[0]!.read).toMatchObject({ call: "too_few", usableBefore: 0, after: 30 });
    expect(r.verdicts[0]!.check.settled).toBe(true);
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
