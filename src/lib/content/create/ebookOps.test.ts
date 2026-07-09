import { describe, it, expect } from "vitest";
import { applyEbookOps, extractEbookOps, EbookOpSchema, type EbookOp } from "./ebookOps";
import { buildImageAnchor } from "./ebookHtml";
import { CONTENT_PLAN_LIMITS, type EbookDoc, type EbookChapter } from "@/lib/types/contentPlan";

function chapter(id: string, over: Partial<EbookChapter> = {}): EbookChapter {
  return { id, title: `Title ${id}`, summary: `Summary ${id}`, bodyHtml: "", status: "planned", images: [], ...over };
}
function book(over: Partial<EbookDoc> = {}): EbookDoc {
  return {
    title: "Book",
    subtitle: "Sub",
    industryLens: "SaaS",
    tocConfirmed: true,
    chapters: [chapter("c1"), chapter("c2"), chapter("c3")],
    ...over,
  };
}

// Deterministic id generators for assertions.
function seq(prefix: string) {
  let n = 0;
  return () => `${prefix}${++n}`;
}
const ids = () => ({ chapter: seq("nc"), slot: seq("ns") });

describe("applyEbookOps — scalar sets", () => {
  it("sets title/subtitle; ignores a blank title", () => {
    expect(applyEbookOps(book(), [{ op: "set_title", value: "New" }]).title).toBe("New");
    expect(applyEbookOps(book(), [{ op: "set_title", value: "  " }]).title).toBe("Book"); // blank ignored
    expect(applyEbookOps(book(), [{ op: "set_subtitle", value: "" }]).subtitle).toBe("");
  });

  it("sets a chapter title/summary by id; unknown id is a no-op", () => {
    const d1 = applyEbookOps(book(), [{ op: "set_chapter_title", chapterId: "c2", value: "Two" }]);
    expect(d1.chapters[1]!.title).toBe("Two");
    const d2 = applyEbookOps(book(), [{ op: "set_chapter_summary", chapterId: "nope", value: "x" }]);
    expect(d2).toEqual(book()); // no-op
  });
});

describe("applyEbookOps — structure", () => {
  it("adds a chapter after a given id, else appends", () => {
    const after = applyEbookOps(book(), [{ op: "add_chapter", afterChapterId: "c1", title: "New", summary: "s" }], ids());
    expect(after.chapters.map((c) => c.id)).toEqual(["c1", "nc1", "c2", "c3"]);
    const appended = applyEbookOps(book(), [{ op: "add_chapter", afterChapterId: null, title: "End", summary: "" }], ids());
    expect(appended.chapters.map((c) => c.id)).toEqual(["c1", "c2", "c3", "nc1"]);
    const unknownAfter = applyEbookOps(book(), [{ op: "add_chapter", afterChapterId: "ghost", title: "End", summary: "" }], ids());
    expect(unknownAfter.chapters.at(-1)!.id).toBe("nc1"); // unknown after → append
  });

  it("enforces MAX_CHAPTERS on add", () => {
    const full = book({ chapters: Array.from({ length: CONTENT_PLAN_LIMITS.MAX_CHAPTERS }, (_, i) => chapter(`c${i}`)) });
    const out = applyEbookOps(full, [{ op: "add_chapter", title: "Over", summary: "" }], ids());
    expect(out.chapters).toHaveLength(CONTENT_PLAN_LIMITS.MAX_CHAPTERS);
  });

  it("removes a chapter; unknown id no-op", () => {
    expect(applyEbookOps(book(), [{ op: "remove_chapter", chapterId: "c2" }]).chapters.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(applyEbookOps(book(), [{ op: "remove_chapter", chapterId: "ghost" }]).chapters).toHaveLength(3);
  });

  it("reorders by id list, drops ghosts, keeps omitted chapters at the end", () => {
    const out = applyEbookOps(book(), [{ op: "reorder_chapters", order: ["c3", "ghost", "c1"] }]);
    expect(out.chapters.map((c) => c.id)).toEqual(["c3", "c1", "c2"]); // c2 omitted → kept last
  });
});

describe("applyEbookOps — bodies + image slots", () => {
  it("replace_chapter_body reconciles slots against the new body", () => {
    const withImg = book({
      chapters: [chapter("c1", { bodyHtml: `<p>a</p>${buildImageAnchor("img_1")}`, images: [{ id: "img_1", status: "placeholder", imageAssetRef: null, aspect: "1:1", width: 100, contextPrompt: "", imagePrompt: null }] })],
    });
    // New body drops the anchor → slot pruned.
    const out = applyEbookOps(withImg, [{ op: "replace_chapter_body", chapterId: "c1", bodyHtml: "<p>rewritten</p>" }]);
    expect(out.chapters[0]!.bodyHtml).toBe("<p>rewritten</p>");
    expect(out.chapters[0]!.images).toHaveLength(0);
  });

  it("insert_image_slot appends a slot + anchor; enforces the per-chapter cap", () => {
    const out = applyEbookOps(book(), [{ op: "insert_image_slot", chapterId: "c1", contextPrompt: "a hero", aspect: "1:4" }], ids());
    const c1 = out.chapters[0]!;
    expect(c1.images).toHaveLength(1);
    expect(c1.images[0]).toMatchObject({ id: "ns1", contextPrompt: "a hero", aspect: "1:4", status: "placeholder" });
    expect(c1.bodyHtml).toContain(buildImageAnchor("ns1"));

    const full = book({ chapters: [chapter("c1", { images: Array.from({ length: CONTENT_PLAN_LIMITS.MAX_IMAGES_PER_CHAPTER }, (_, i) => ({ id: `img_${i}`, status: "placeholder" as const, imageAssetRef: null, aspect: "1:1" as const, width: 100, contextPrompt: "", imagePrompt: null })) })] });
    const capped = applyEbookOps(full, [{ op: "insert_image_slot", chapterId: "c1", contextPrompt: "x" }], ids());
    expect(capped.chapters[0]!.images).toHaveLength(CONTENT_PLAN_LIMITS.MAX_IMAGES_PER_CHAPTER);
  });

  it("insert_image_slot is a no-op when the body has no room for the anchor (cap guard)", () => {
    const nearMax = "x".repeat(CONTENT_PLAN_LIMITS.MAX_CHAPTER_CHARS - 10);
    const full = book({ chapters: [chapter("c1", { bodyHtml: nearMax })] });
    const out = applyEbookOps(full, [{ op: "insert_image_slot", chapterId: "c1", contextPrompt: "x" }], ids());
    expect(out.chapters[0]!.images).toHaveLength(0); // the ~34-char anchor wouldn't fit
    expect(out.chapters[0]!.bodyHtml).toBe(nearMax);
  });

  it("remove_image_slot drops the slot and strips its anchor", () => {
    const withImg = book({
      chapters: [chapter("c1", { bodyHtml: `<p>a</p>${buildImageAnchor("img_1")}<p>b</p>`, images: [{ id: "img_1", status: "generated", imageAssetRef: "x.png", aspect: "1:1", width: 100, contextPrompt: "", imagePrompt: null }] })],
    });
    const out = applyEbookOps(withImg, [{ op: "remove_image_slot", chapterId: "c1", slotId: "img_1" }]);
    expect(out.chapters[0]!.images).toHaveLength(0);
    expect(out.chapters[0]!.bodyHtml).not.toContain("data-ebook-image");
  });
});

describe("EbookOpSchema + extractEbookOps", () => {
  it("rejects malformed ops", () => {
    expect(EbookOpSchema.safeParse({ op: "bogus" }).success).toBe(false);
    expect(EbookOpSchema.safeParse({ op: "set_chapter_title", chapterId: "c1" }).success).toBe(false); // missing value
  });

  it("pulls ops from a fenced block and filters invalid ones", () => {
    const reply = 'Sure! Renaming that.\n```ops\n{"ops":[{"op":"set_title","value":"X"},{"op":"nope"}]}\n```';
    const ops = extractEbookOps(reply);
    expect(ops).toEqual([{ op: "set_title", value: "X" }]);
  });

  it("falls back to a bare JSON object; returns [] when there are no ops", () => {
    expect(extractEbookOps('{"ops":[{"op":"set_subtitle","value":"Y"}]}')).toEqual([{ op: "set_subtitle", value: "Y" }]);
    expect(extractEbookOps("just a chat reply, no changes")).toEqual([]);
  });

  it("applies extracted ops end-to-end", () => {
    const ops: EbookOp[] = extractEbookOps('```ops\n{"ops":[{"op":"set_chapter_title","chapterId":"c1","value":"Intro"}]}\n```');
    expect(applyEbookOps(book(), ops).chapters[0]!.title).toBe("Intro");
  });
});
