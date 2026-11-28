import { describe, expect, it } from "vitest";
import { industryOf, UNKNOWN_INDUSTRY } from "./industry";
import { MEMORY_BANK_KINDS } from "./learnLog";
import { LOOPS } from "./registry";
import { IMAGE_POOL, LOGGED_OWN_KINDS, ROW_KINDS, rowKindOf, rowLine, rowsOfWeek, rowStage, STAGE_WEEKS, stagesThrough, type LookInUse, type RowWeek } from "./stages";

/** The six stages and the stuck rule (learning loops step 5, 4.6), read from a brand's folded weeks. */

const END = new Date("2026-12-14T00:00:00.000Z");
const NATURAL = "image_style.natural_photo";

/** A week's counters for one kind of words, at version 0, arm none, in its own scope. */
const words = (kind: string, signals: Record<string, number>, more: Record<string, unknown> = {}) => ({ c: { [kind]: { [kind]: { v0: { none: signals } } } }, ...more });
const weeksOf = (row: string, ...ds: unknown[]): Array<RowWeek | undefined> => ds.map((d) => rowsOfWeek(d).get(row));

describe("rows", () => {
  it("counts the five image kinds and the image learner once, as the pool, and every other kind as itself", () => {
    for (const kind of ["post_image", "blog_hero", "ebook_image", "email_block_image", "email_hero", "loop_learn"]) expect(rowKindOf(kind), kind).toBe(IMAGE_POOL);
    expect(rowKindOf("customize_image")).toBe("customize_image");
    expect(rowKindOf("next_up")).toBe("next_up");
    expect(rowKindOf("canvas.journey")).toBe("canvas.journey");
    expect(rowKindOf("ten_hearth")).toBeNull();
    expect(new Set(Object.keys(LOOPS).map(rowKindOf))).toEqual(new Set(ROW_KINDS));
  });

  it("lets only kinds that learn, and the Memory Bank lines that log learning, reach Signalled; only the verdict's kinds reach Checked", () => {
    expect(LOGGED_OWN_KINDS).toEqual(MEMORY_BANK_KINDS);
    expect(rowLine(IMAGE_POOL)).toEqual({ learns: true, checks: true });
    expect(rowLine("edit_mode")).toEqual({ learns: true, checks: false });
    expect(rowLine("content_write")).toEqual({ learns: true, checks: false });
    expect(rowLine("next_up")).toEqual({ learns: false, checks: false });
    expect(rowLine("customize_image")).toEqual({ learns: false, checks: false });
    expect(STAGE_WEEKS).toBe(4);
  });

  it("reads a week's counters by row: signals, the why behind votes and dismissals, styles, own images, refusals and cards", () => {
    const rows = rowsOfWeek({
      c: {
        [NATURAL]: { post_image: { v1: { learned: { made: 3, voted: 2, liked: 1, "disliked.wrong_mood": 1 }, holdback: { made: 1 } } } },
        "image_style.brand": { loop_learn: { v2: { learned: { undone: 1 } } } },
        next_up: { next_up: { v0: { none: { made: 3, declined: 1, "declined.not_relevant": 1 } } } },
        "ten_x/../y": { next_up: { v0: { none: { made: 1 } } } },
      },
      u: { next_up: { records_off: 2 }, nope: { x: 1 } },
      r: { loop_learn: { learned: 1, error: 2 }, edit_mode: { plan: 3 } },
      k: { loop_learn: { proposed: 1 } },
      o: { image: { voted: 1, liked: 1 } },
      t: { content_plan: { made: 2 } },
    });
    const pool = rows.get(IMAGE_POOL)!;
    expect(pool.made).toBe(4);
    // Voted 2, liked 1, the Undo 1, and the own image's vote and like.
    expect(pool.signals).toBe(6);
    expect(pool.out).toEqual({ learned: { made: 3, voted: 2, liked: 1, undone: 1 }, holdback: { made: 1 } });
    expect(pool.scope).toEqual({ natural_photo: { learned: { made: 3, voted: 2, liked: 1 }, holdback: { made: 1 } } });
    expect(pool.disliked).toEqual({ wrong_mood: 1 });
    expect(pool.own).toEqual({ voted: 1, liked: 1 });
    expect(pool.learned).toBe(1);
    expect(pool.refused).toEqual({ error: 2 });
    expect(pool.cards).toEqual({ proposed: 1 });
    const next = rows.get("next_up")!;
    expect(next.made).toBe(4);
    expect(next.declinedWhy).toEqual({ not_relevant: 1 });
    expect(next.unstamped).toEqual({ records_off: 2 });
    // A Memory Bank line is a person's edit reaching the learner: a signal, and a refusal by reason.
    expect(rows.get("edit_mode")).toMatchObject({ signals: 3, refused: { plan: 3 }, learned: 0 });
    expect(rows.has("nope")).toBe(false);
  });
});

describe("the stages", () => {
  it("reaches Stamped by making, and never further for a kind that doesn't learn", () => {
    const st = rowStage("next_up", weeksOf("next_up", undefined, undefined, undefined, words("next_up", { made: 30, kept: 4 })), [], END);
    expect(st.reached).toBe("stamped");
    expect(st.stuck).toBeNull();
    expect(stagesThrough(st.reached)).toEqual(["stamped"]);
  });

  it("reaches Signalled on a person signal, Learning on a learn or a look in use, and Checked on a read at a look", () => {
    const img = (signals: Record<string, number>) => ({ c: { [NATURAL]: { post_image: { v1: { learned: signals } } } } });
    expect(rowStage(IMAGE_POOL, weeksOf(IMAGE_POOL, img({ made: 2, voted: 1 })), [], END).reached).toBe("signalled");
    expect(rowStage(IMAGE_POOL, weeksOf(IMAGE_POOL, { ...img({ made: 2, voted: 1 }), r: { loop_learn: { learned: 1 } } }), [], END).reached).toBe("learning");
    const look: LookInUse = { scope: NATURAL, adoptedAt: "2026-09-01T00:00:00.000Z", checked: false };
    expect(rowStage(IMAGE_POOL, weeksOf(IMAGE_POOL, img({ made: 2 })), [look], END).reached).toBe("learning");
    expect(rowStage(IMAGE_POOL, weeksOf(IMAGE_POOL, img({ made: 2 })), [{ ...look, checked: true }], END).reached).toBe("checked");
    expect(stagesThrough("checked")).toEqual(["stamped", "signalled", "learning", "checked"]);
  });

  it("shows Learning with no check as a wait, never as stuck, with the days since the oldest unchecked look began", () => {
    const looks: LookInUse[] = [
      { scope: NATURAL, adoptedAt: "2026-09-15T00:00:00.000Z", checked: false },
      { scope: "image_style.brand", adoptedAt: "2026-11-14T00:00:00.000Z", checked: true },
    ];
    const st = rowStage(IMAGE_POOL, weeksOf(IMAGE_POOL, undefined), looks, END);
    expect(st).toMatchObject({ reached: "checked", stuck: null, waitDays: 90 });
    // A Memory Bank line learns but is never checked, so it never waits.
    expect(rowStage("edit_mode", weeksOf("edit_mode", { r: { edit_mode: { learned: 2 } } }), looks, END)).toMatchObject({ reached: "learning", waitDays: null });
  });
});

describe("stuck", () => {
  const made = (n: number) => words("edit_mode", { made: n });
  const refusedPlan = (n: number, m = 1) => words("edit_mode", { made: m }, { r: { edit_mode: { plan: n } } });

  it("is stuck at Stamped after 28 days with no person signal, or once 10 are made with none, whichever comes first", () => {
    // Made in the window's first week and nothing since: 28 days.
    expect(rowStage("edit_mode", weeksOf("edit_mode", made(1), undefined, undefined, undefined), [], END).stuck).toBe("stamped");
    // Only 3 weeks, 9 made: not yet.
    expect(rowStage("edit_mode", weeksOf("edit_mode", undefined, made(3), made(3), made(3)), [], END).stuck).toBeNull();
    // 10 made in one week: at once.
    expect(rowStage("edit_mode", weeksOf("edit_mode", undefined, undefined, undefined, made(10)), [], END).stuck).toBe("stamped");
  });

  it("is stuck at Signalled when signals came since the window's first week, or 10 were made since the first, and nothing was learned", () => {
    const st = rowStage("edit_mode", weeksOf("edit_mode", refusedPlan(2), refusedPlan(1), undefined, refusedPlan(1)), [], END);
    expect(st).toMatchObject({ reached: "signalled", stuck: "signalled", topReason: "plan", refused: { plan: 4 } });
    expect(rowStage("edit_mode", weeksOf("edit_mode", undefined, refusedPlan(1, 4), made(4), made(2)), [], END).stuck).toBe("signalled");
    expect(rowStage("edit_mode", weeksOf("edit_mode", undefined, refusedPlan(1, 4), made(4), made(1)), [], END).stuck).toBeNull();
  });

  it("counts posts that went out with no AI draft kept, never as a person signal, so the row stays stuck at Stamped and says why", () => {
    const noDraft = words("content_write", { made: 3, no_draft: 3 });
    const w = rowsOfWeek(noDraft).get("content_write")!;
    expect(w).toMatchObject({ made: 3, signals: 0, noDraft: 3 });
    expect(w.out).toEqual({ none: { made: 3 } });
    const st = rowStage("content_write", weeksOf("content_write", noDraft, noDraft, undefined, noDraft), [], END);
    expect(st).toMatchObject({ reached: "stamped", stuck: "stamped", noDraft: 9 });
  });

  it("is never stuck at Declared or at Learning", () => {
    expect(rowStage("edit_mode", weeksOf("edit_mode", undefined, undefined, undefined, undefined), [], END)).toMatchObject({ reached: null, stuck: null });
    const learning = rowStage("edit_mode", weeksOf("edit_mode", refusedPlan(3, 12), undefined, undefined, { r: { edit_mode: { learned: 1 } } }), [], END);
    expect(learning).toMatchObject({ reached: "learning", stuck: null });
  });
});

describe("industry", () => {
  it("is unknown for every brand until onboarding writes one", () => {
    expect(industryOf({ id: "ten_hearth" })).toBe(UNKNOWN_INDUSTRY);
    expect(UNKNOWN_INDUSTRY).toBe("unknown");
  });
});
