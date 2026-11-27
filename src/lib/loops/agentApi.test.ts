import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { LOOP_DAYS, loopDayId, readLoopDays } from "@/lib/tenant/loops";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import {
  agentLearning,
  COUNT_WORDS,
  daysOf,
  KINDS_ASKED_MAX,
  LEARNING_READS_MAX,
  NOTE,
  parseLearningQuery,
  POOL_HOW,
  rowOfName,
  SET_BY_WORDS,
  STATUS_WORDS,
  stuckWords,
} from "./agentApi";
import { loopWeekOf } from "./count";
import { weekBefore } from "./fold";
import { LOOP_RULES } from "./registry";
import { IMAGE_POOL, ROW_KINDS } from "./stages";

/**
 * get_learning (learning loops step 5, 4.10): Hearth Bakery's own learning by kind, read from its
 * `lb:`, `lt:`, `lw:` and `lv:` documents on a fake Firestore through the real tenant layer.
 */

const NOW = new Date("2027-01-15T09:00:00.000Z");
const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "agent", userId: "usr_maya" };
const NATURAL = "image_style.natural_photo";

let db: FakeFirestore;

/** The ISO week n weeks before the open one (0 is the open week). */
const week = (n: number) => {
  let w = loopWeekOf(NOW);
  for (let i = 0; i < n; i++) w = weekBefore(w);
  return w;
};
const folded = (n: number, d: Record<string, unknown>, tenantId = hearth.tenantId) => db.seed(LOOP_DAYS, loopDayId.folded(tenantId, week(n)), { tenantId, d });
const shard = (n: number, i: number, d: Record<string, unknown>, tenantId = hearth.tenantId) => db.seed(LOOP_DAYS, loopDayId.week(tenantId, week(n), i), { tenantId, d });
/** A words kind's counts: `c.<kind>.<kind>.v0.none.<signal>`. */
const words = (kind: string, signals: Record<string, number>, more: Record<string, unknown> = {}) => ({ c: { [kind]: { [kind]: { v0: { none: signals } } } }, ...more });

type Entry = {
  kind: string;
  label: string;
  line: string;
  how: string;
  status: string;
  statusWords: string;
  stuck: { at: string; words: string; reason: string | null; reasonWords: string | null } | null;
  counts: Record<string, number>;
  shares?: Record<string, number | null>;
  learner?: { learned: number; refused: Array<{ reason: string; words: string; times: number }> };
  byKind?: Array<{ kind: string; label: string; made: number }>;
  looks?: Array<Record<string, unknown>>;
  declinedWhy?: Array<{ why: string; words: string; times: number }>;
  unstamped?: Array<{ reason: string; words: string; times: number }>;
};
type Body = {
  days: number;
  weeks: { from: string; to: string; startsOn: string; openWeek: string; weeksNotYetAddedUp: number };
  countsAcrossBrands: { included: boolean; since?: string; words: string };
  imageLearning: { paused: boolean; since?: string; words?: string };
  kinds: Entry[];
  notFound?: string[];
  moreKinds: number;
  note: string;
  meanings: Record<string, unknown>;
};

async function ask(q: Parameters<typeof agentLearning>[1] = {}, ctx = hearth): Promise<Body> {
  const r = await agentLearning(ctx, q, { db, now: NOW });
  expect(r.status).toBe(200);
  return r.body as Body;
}
const entry = (b: Body, kind: string) => b.kinds.find((k) => k.kind === kind);

beforeEach(() => {
  db = new FakeFirestore();
});
afterEach(() => vi.restoreAllMocks());

describe("which weeks", () => {
  it("defaults to the last 90 days: the open week so far and the 12 closed weeks before it", async () => {
    folded(13, words("next_up", { made: 5 }));
    folded(12, words("next_up", { made: 2, kept: 1 }));
    shard(0, 2, words("next_up", { made: 1 }));
    const b = await ask();
    expect(b.days).toBe(90);
    expect(b.weeks).toMatchObject({ from: week(12), to: week(0), openWeek: week(0), weeksNotYetAddedUp: 0 });
    expect(b.weeks.startsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entry(b, "next_up")?.counts).toEqual({ made: 3, kept: 1 });
  });

  it("covers the days asked, from 7 up to 182", async () => {
    folded(1, words("next_up", { made: 2 }));
    shard(0, 0, words("next_up", { made: 1 }));
    expect(entry(await ask({ days: 7 }), "next_up")?.counts.made).toBe(1);
    expect(entry(await ask({ days: 14 }), "next_up")?.counts.made).toBe(3);
    folded(25, words("next_up", { made: 4 }));
    expect((await ask({ days: 1000 })).days).toBe(182);
    expect(entry(await ask({ days: 1000 }), "next_up")?.counts.made).toBe(7);
    expect([daysOf(undefined), daysOf(Number.NaN), daysOf(0), daysOf(3), daysOf(30.4), daysOf(400)]).toEqual([90, 90, 90, 7, 30, 182]);
  });

  it("reads a closed week the lane hasn't folded from its shards, and a folded week from its folded copy only", async () => {
    shard(1, 0, words("next_up", { made: 1 }));
    shard(1, 3, words("next_up", { made: 1 }));
    folded(2, words("next_up", { made: 4 }));
    // A folded week's shards stay until their time to live: never counted twice.
    shard(2, 1, words("next_up", { made: 9 }));
    const b = await ask();
    expect(entry(b, "next_up")?.counts.made).toBe(6);
    expect(b.weeks.weeksNotYetAddedUp).toBe(1);
  });
});

describe("which kinds", () => {
  beforeEach(() => {
    shard(0, 0, { c: { [NATURAL]: { post_image: { v1: { learned: { made: 4, voted: 2, liked: 1 } } }, blog_hero: { v1: { learned: { made: 1 } } } } } });
    folded(1, words("trending", { made: 6 }));
    folded(2, words("edit_mode", { made: 3 }));
    folded(3, words("blog_write", { made: 2 }));
  });

  it("lists the kinds made in these weeks, learning kinds first, then own, gap and none", async () => {
    const b = await ask();
    expect(b.kinds.map((k) => k.kind)).toEqual([IMAGE_POOL, "edit_mode", "blog_write", "trending"]);
    expect(b.kinds.map((k) => k.line)).toEqual(["learns", "own", "gap", "none"]);
    const pool = entry(b, IMAGE_POOL)!;
    expect(pool).toMatchObject({ label: "Image style", how: POOL_HOW, counts: { made: 5, voted: 2, liked: 1 } });
    expect(pool.byKind).toEqual([
      { kind: "post_image", label: "Post images", made: 4 },
      { kind: "blog_hero", label: expect.any(String), made: 1 },
    ]);
    // Images show their votes; words kinds their shares.
    expect(pool.shares).toBeUndefined();
    expect(entry(b, "trending")).toMatchObject({ label: "Trending topics", status: "stamped", statusWords: STATUS_WORDS.stamped.none, stuck: null });
    expect(entry(b, "blog_write")).toMatchObject({ statusWords: STATUS_WORDS.stamped.gap, revisit: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(entry(b, "next_up")).toBeUndefined();
    expect(b.moreKinds).toBe(ROW_KINDS.length - 4);
  });

  it("gives the rest by key or label, and all of them on request", async () => {
    const b = await ask({ kinds: ["Next up", "edit_mode", "post_image", "Nothing like this"] });
    expect(b.kinds.map((k) => k.kind)).toEqual([IMAGE_POOL, "edit_mode", "next_up"]);
    expect(entry(b, "next_up")).toMatchObject({ status: "nothing_made", statusWords: STATUS_WORDS.nothing_made, counts: { made: 0 } });
    expect(b.notFound).toEqual(["Nothing like this"]);
    const all = await ask({ all: true });
    expect(all.kinds).toHaveLength(ROW_KINDS.length);
    expect(all.moreKinds).toBe(0);
    expect(all.notFound).toBeUndefined();
  });

  it("finds a kind by its key or label, any case, and the image kinds' pool by any of its kinds", () => {
    expect(rowOfName("Post images")).toBe(IMAGE_POOL);
    expect(rowOfName("blog_hero")).toBe(IMAGE_POOL);
    expect(rowOfName("image style")).toBe(IMAGE_POOL);
    expect(rowOfName("loop_learn")).toBe(IMAGE_POOL);
    expect(rowOfName("  EDIT MODE ")).toBe("edit_mode");
    expect(rowOfName("customize_image")).toBe("customize_image");
    expect(rowOfName("tenants")).toBeNull();
  });
});

describe("status, stuck and the learner", () => {
  it("says where a kind is stuck by the per brand rule, with the learner's most common reason in words", async () => {
    for (const n of [1, 2, 3, 4]) folded(n, words("edit_mode", { made: 1 }, { r: { edit_mode: { plan: 2 } } }));
    folded(1, words("edit_mode", { made: 1 }, { r: { edit_mode: { plan: 2, floor: 1 } } }));
    const e = entry(await ask(), "edit_mode")!;
    expect(e.status).toBe("signalled");
    expect(e.statusWords).toBe(STATUS_WORDS.signalled);
    expect(e.stuck).toEqual({ at: "signalled", words: stuckWords("signalled", "plan"), reason: "plan", reasonWords: "Not in the brand's plan" });
    expect(e.stuck!.words).toContain("not in the brand's plan");
    expect(e.learner).toEqual({
      learned: 0,
      refused: [
        { reason: "plan", words: "Not in the brand's plan", times: 8 },
        { reason: "floor", words: "Not enough to learn from yet", times: 1 },
      ],
    });
  });

  it("says Learning once something was learned, with no stuck step", async () => {
    for (const n of [1, 2, 3, 4]) folded(n, words("edit_mode", { made: 1 }, { r: { edit_mode: n === 2 ? { learned: 1 } : { plan: 1 } } }));
    const e = entry(await ask(), "edit_mode")!;
    expect(e).toMatchObject({ status: "learning", statusWords: STATUS_WORDS.learning, stuck: null });
    expect(e.learner?.learned).toBe(1);
  });

  it("gives shares of what was made, and the unused share only from weeks with 2 closed weeks after them", async () => {
    folded(4, words("next_up", { made: 10, kept: 3 }));
    folded(3, words("next_up", { kept: 2, edited: 1 }));
    folded(2, words("next_up", { declined: 1, "declined.not_for_us": 1 }));
    folded(1, words("next_up", { made: 2 }, { u: { next_up: { stamp_lost: 1, own_image: 2 } } }));
    shard(0, 0, words("next_up", { kept: 1 }));
    const b = await ask();
    const e = entry(b, "next_up")!;
    expect(e.counts).toEqual({ made: 12, kept: 6, edited: 1, declined: 1 });
    // Made 10 in the oldest week, 7 answered through 2 weeks on: 3 unused. Week 1 has no 2 closed weeks after it.
    expect(e.shares).toEqual({ keptShare: 0.5, editShare: 0.08, declineShare: 0.08, unusedShare: 0.3 });
    expect(e.declinedWhy).toEqual([{ why: "not_for_us", words: "Not for us", times: 1 }]);
    expect(e.unstamped).toEqual([
      { reason: "own_image", words: "a person's own image", times: 2 },
      { reason: "stamp_lost", words: "a stamp lost", times: 1 },
    ]);
    expect(Object.keys(b.meanings).sort()).toEqual(["declineShare", "editShare", "keptShare", "unusedShare"]);
  });
});

describe("the image looks", () => {
  it("lists each look in use with its counts, the pause and the opt out, and leaves the words to get_image_style", async () => {
    db.seed(LOOP_DAYS, loopDayId.brand(hearth.tenantId), {
      tenantId: hearth.tenantId,
      d: {
        scopes: {
          [NATURAL]: { v: 1, setBy: "learned", adoptedAt: "2026-12-01T09:00:00.000Z" },
          "image_style.brand": { v: 2, setBy: "person", adoptedAt: "2026-12-20T09:00:00.000Z" },
          "image_style.illustration": { v: 3, setBy: "learned", adoptedAt: "2027-01-02T09:00:00.000Z" },
        },
        forgot: { "image_style.illustration": { at: "2027-01-02T09:00:00.000Z" } },
        pause: { image_style: { at: "2027-01-10T09:00:00.000Z" } },
        fleetOptOut: { at: "2026-06-03T09:00:00.000Z" },
      },
    });
    db.seed(LOOP_DAYS, loopDayId.version(hearth.tenantId, NATURAL, 1), {
      tenantId: hearth.tenantId,
      d: { throughWeek: week(1), c: { post_image: { learned: { made: 20, voted: 10, liked: 7, remade: 2 }, holdback: { made: 1 } } }, looks: { "10": { call: "better" } } },
    });
    const b = await ask();
    const pool = entry(b, IMAGE_POOL)!;
    expect(pool.status).toBe("checked");
    expect(pool.statusWords).toBe(STATUS_WORDS.checked);
    expect(pool.looks).toEqual([
      {
        scope: NATURAL,
        style: "Natural photo",
        version: 1,
        setBy: "learned",
        setByWords: SET_BY_WORDS.learned,
        since: "2026-12-01",
        checked: true,
        made: 20,
        voted: 10,
        liked: 7,
        remade: 2,
        heldBack: 1,
        likedShare: 0.7,
        remadeShare: 0.1,
        countedThrough: week(1),
      },
      expect.objectContaining({ scope: "image_style.brand", style: "Your brand's look", version: 2, setBy: "person", checked: false, made: 0, likedShare: null }),
    ]);
    // A forgotten look is no look in use.
    expect(pool.looks!.some((l) => l.scope === "image_style.illustration")).toBe(false);
    expect(b.imageLearning).toMatchObject({ paused: true, since: "2027-01-10" });
    expect(b.countsAcrossBrands).toEqual({ included: false, since: "2026-06-03", words: "Left out of the counts across brands since 3 Jun: this brand's counts stay with this brand." });
    expect(Object.keys(b.meanings)).toEqual(expect.arrayContaining(["likedShare", "remadeShare"]));
    expect(b.note).toContain("get_image_style");
  });
});

describe("what it reads", () => {
  it("reads only this brand's lb:, lt:, lw: and lv: documents, in at most two bounded reads, never another brand's", async () => {
    const lumen = "ten_lumen";
    db.seed(LOOP_DAYS, loopDayId.brand(hearth.tenantId), { tenantId: hearth.tenantId, d: { scopes: Object.fromEntries(["natural_photo", "illustration", "brand"].map((s) => [`image_style.${s}`, { v: 1, setBy: "learned", adoptedAt: "2026-12-01T09:00:00.000Z" }])) } });
    folded(2, words("next_up", { made: 1 }));
    folded(2, words("next_up", { made: 500 }), lumen);
    shard(0, 0, words("next_up", { made: 500 }), lumen);
    const reads: string[][] = [];
    const read = (ids: readonly string[]) => {
      reads.push([...ids]);
      return readLoopDays(hearth, ids, db);
    };
    const r = await agentLearning(hearth, { all: true, days: 182 }, { db, now: NOW, read });
    expect(entry(r.body as Body, "next_up")?.counts.made).toBe(1);
    expect(reads.length).toBeLessThanOrEqual(2);
    const ids = reads.flat();
    expect(ids.length).toBeLessThanOrEqual(LEARNING_READS_MAX);
    for (const id of ids) {
      expect(id, id).toMatch(/^(?:lb|lt|lw|lv):ten_hearth(?::|$)/);
      expect(id).not.toMatch(/^(?:ls|lk):|^fh:/);
    }
    expect(ids.filter((id) => id.startsWith("lv:"))).toHaveLength(3);
    // The pointers, 25 folded weeks and the open week's shards first; then the looks and unfolded weeks' shards.
    expect(reads[0]!.filter((id) => id.startsWith("lt:"))).toHaveLength(25);
    expect(reads[1]!.filter((id) => id.startsWith("lw:")).length).toBeLessThanOrEqual(10 * LOOP_RULES.shards);
  });

  it("makes one read when nothing is in use and every closed week is folded or past its shards", async () => {
    for (let n = 1; n <= 12; n++) folded(n, words("next_up", { made: 1 }));
    const reads: string[][] = [];
    await agentLearning(hearth, {}, { db, now: NOW, read: (ids) => (reads.push([...ids]), readLoopDays(hearth, ids, db)) });
    expect(reads).toHaveLength(1);
  });
});

describe("the query and the words", () => {
  it("reads kinds, all and days from the query, and nothing else", () => {
    expect(parseLearningQuery(new URLSearchParams("kinds=edit_mode, Post images,,&all=yes&days=30&tenantId=ten_lumen"))).toEqual({ kinds: ["edit_mode", "Post images"], all: true, days: 30 });
    expect(parseLearningQuery(new URLSearchParams("days=soon"))).toEqual({});
    expect(parseLearningQuery(new URLSearchParams(`kinds=${Array.from({ length: 30 }, (_, i) => `k${i}`).join(",")}`)).kinds).toHaveLength(KINDS_ASKED_MAX);
  });

  it("keeps every line in house style: no dashes as punctuation and none of the AI tells", async () => {
    folded(1, words("edit_mode", { made: 1 }, { r: { edit_mode: { plan: 1 } } }));
    const b = await ask({ all: true });
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(b);
    walk([NOTE, POOL_HOW, STATUS_WORDS, COUNT_WORDS, SET_BY_WORDS, stuckWords("stamped", null), stuckWords("signalled", "error")]);
    expect(strings.length).toBeGreaterThan(100);
    for (const s of strings) expect([...dashesIn(s), ...aiTellsIn(s)], s).toEqual([]);
  });
});
