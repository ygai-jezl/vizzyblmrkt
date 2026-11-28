import { afterEach, describe, expect, it, vi } from "vitest";
import { ANSWER_WEEKS, coverageByKind, tallyByKind, unusedForWeek, unusedOfVersion } from "./tally";

/** Reading a brand's counts back by kind (src/lib/loops/tally.ts, learning loops step 5, 4.4). */

const NATURAL = "image_style.natural_photo";

/** A week of Hearth Bakery's counters, as the fold keeps it on `lt:`. */
const week = {
  c: {
    content_write: { content_write: { v0: { none: { made: 10, kept: 4, edited: 3, declined: 1 } } } },
    blog_write: { blog_write: { v0: { none: { made: 2 } } } },
    [NATURAL]: { post_image: { v1: { learned: { made: 6, voted: 4, liked: 3 }, holdback: { made: 1 } } } },
  },
  u: { content_write: { person_wrote: 3, stamp_lost: 1 }, post_image: { own_image: 2 } },
  t: { content_plan: { made: 12 } },
};

describe("a week by kind", () => {
  it("adds up made and what people did across scopes, versions and arms", () => {
    const t = tallyByKind(week);
    expect(t.get("content_write")).toEqual({ made: 10, kept: 4, edited: 3, declined: 1, noDraft: 0, unstamped: 3, lost: 1, recordsOff: 0 });
    expect(t.get("post_image")).toEqual({ made: 7, kept: 0, edited: 0, declined: 0, noDraft: 0, unstamped: 2, lost: 0, recordsOff: 0 });
    expect(t.get("blog_write")).toMatchObject({ made: 2 });
    // Types and anything that isn't a counter are left out.
    expect([...t.keys()].sort()).toEqual(["blog_write", "content_write", "post_image"]);
    expect(tallyByKind(null).size).toBe(0);
    expect(tallyByKind({ c: { x: "nope", y: { z: [1] } } }).get("z")).toMatchObject({ made: 0 });
  });

  it("says how much of each kind is stamped: stamped over stamped, unstamped and lost", () => {
    const c = coverageByKind(week);
    // The image whose library row was lost was counted made too: it is one of the 10, not stamped.
    expect(c.get("content_write")).toEqual({ stamped: 9, unstamped: 3, lost: 1, share: 9 / 13 });
    expect(c.get("post_image")).toEqual({ stamped: 7, unstamped: 2, lost: 0, share: 7 / 9 });
    expect(c.get("blog_write")?.share).toBe(1);
    // Ten emails sent with send records off: each counted made against its stamp and records_off beside it, and none is kept with a stamp.
    expect(coverageByKind({ c: { send_time: { send_time: { v0: { none: { made: 10 } } } } }, u: { send_time: { records_off: 10 } } }).get("send_time")).toEqual({ stamped: 0, unstamped: 10, lost: 0, share: 0 });
    // Nothing saved: no share.
    expect(coverageByKind({ c: { edit_mode: { edit_mode: { v0: { none: { kept: 1 } } } } } }).get("edit_mode")?.share).toBeNull();
  });
});

describe("unused", () => {
  afterEach(() => vi.unstubAllEnvs());

  const answers = (kept: number, edited = 0, declined = 0) => ({ c: { content_write: { content_write: { v0: { none: { kept, edited, declined } } } } } });

  it("is what was made in a week, less what was kept, edited or declined that week and the two after it", () => {
    // An article is answered at the approval of its AI original (ORIGINALS_ONLY), kept where this switch is on.
    vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "true");
    expect(ANSWER_WEEKS).toBe(2);
    const u = unusedForWeek([week, answers(1), answers(0, 0, 1), answers(5)]);
    // 10 made, 8 answered in W, 1 in W+1, 1 in W+2; W+3 is past the window.
    expect(u.get("content_write")).toBe(0);
    expect(unusedForWeek([week]).get("content_write")).toBe(2);
    expect(u.get("blog_write")).toBe(2);
    // Never below 0, even when later weeks answer things made later.
    expect(unusedForWeek([week, answers(40)]).get("content_write")).toBe(0);
  });

  it("never counts a post that went out with no AI draft kept as unused: it was used", () => {
    // Three Hearth Bakery posts published while CONTENT_AI_DRAFT_KEPT_ENABLED is off: counted no_draft, never kept or edited.
    const published = { c: { content_write: { content_write: { v0: { none: { made: 3, no_draft: 3 } } } } } };
    expect(tallyByKind(published).get("content_write")).toMatchObject({ made: 3, noDraft: 3, kept: 0, edited: 0 });
    expect(unusedForWeek([published, undefined, undefined]).get("content_write")).toBe(0);
    // One published the week after counts too, as any answer in the two weeks after does.
    const made = { c: { content_write: { content_write: { v0: { none: { made: 3, no_draft: 1 } } } } } };
    const later = { c: { content_write: { content_write: { v0: { none: { no_draft: 1 } } } } } };
    expect(unusedForWeek([made, later, undefined]).get("content_write")).toBe(1);
  });

  it("leaves image kinds and their learner to their versions, and kinds with nothing made out", () => {
    const u = unusedForWeek([week]);
    expect(u.has("post_image")).toBe(false);
    expect(unusedForWeek([{ c: { [NATURAL]: { loop_learn: { v1: { learned: { made: 1 } } } } } }]).size).toBe(0);
    expect(unusedForWeek([answers(3)]).size).toBe(0);
    expect(unusedForWeek([]).size).toBe(0);
  });

  it("leaves out the kinds no path can answer yet, which would read as all unused", () => {
    const sent = { c: { send_time: { send_time: { v0: { none: { made: 40 } } } }, content_write: { content_write: { v0: { none: { made: 3 } } } } } };
    const u = unusedForWeek([sent]);
    expect(u.has("send_time")).toBe(false);
    expect(u.get("content_write")).toBe(3);
    // Made still counts.
    expect(tallyByKind(sent).get("send_time")?.made).toBe(40);
  });

  it("for a learned version comes from its own totals, by kind and arm", () => {
    expect(
      unusedOfVersion({
        post_image: { learned: { made: 20, voted: 12, kept: 2, declined: 1 }, holdback: { made: 1 } },
        blog_hero: { learned: { voted: 3 } },
      }),
    ).toEqual({ post_image: { learned: 17, holdback: 1 } });
    expect(unusedOfVersion(undefined)).toEqual({});
  });
});
