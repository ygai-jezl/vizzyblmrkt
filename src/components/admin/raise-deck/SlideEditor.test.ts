import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NOW, block } from "@/lib/raise/docs/testing/fixtures";
import { acmeSlides } from "@/lib/raise/docs/testing/view";
import type { Slide } from "@/lib/raise/docs/types";
import { EDITOR_WORDS, STUDIO_WORDS } from "@/lib/raise/docs/words";
import { SlideEditor } from "./SlideEditor";

const noop = () => undefined;
const edit = (slide: Slide, canEdit = true) =>
  renderToStaticMarkup(
    createElement(SlideEditor, { slide, n: 4, stage: "pre_seed", canEdit, now: NOW, onChange: noop, onFocusField: noop, onRemoveBlock: noop, onInsertNumber: noop }),
  );

describe("the slide's words under it", () => {
  const slides = acmeSlides();

  it("shows a number in the words as a chip, never as its token", () => {
    const out = edit(slides.find((s) => s.layout === "chart")!);
    expect(out).toContain("4,310");
    expect(out).toContain("12 weeks to 26 Nov");
    expect(out).not.toContain("{{mb_");
    expect(out).toContain(STUDIO_WORDS.speakerNotes);
  });

  it("puts a number in a column's cell as a chip too", () => {
    const compare = slides.find((s) => s.layout === "compare")!;
    const withNumber: Slide = { ...compare, blocks: [block()], compare: { ...compare.compare!, rows: [{ left: "Count on Sunday", right: "{{mb_aaaaaaaa}} shops count as they sell" }] } };
    const out = edit(withNumber);
    expect(out).toContain(EDITOR_WORDS.columns);
    expect(out).toContain("4,310");
    expect(out).not.toContain("{{mb_");
    expect(edit(withNumber, false)).toContain("4,310 shops count as they sell");
  });

  it("offers the fields a layout shows, and none for a member", () => {
    const team = edit(slides.find((s) => s.layout === "team")!);
    expect(team).toContain(EDITOR_WORDS.addPerson);
    expect(team).toContain('value="Sam Rivera"');
    expect(edit(slides.find((s) => s.layout === "three_points")!)).not.toContain(EDITOR_WORDS.addPoint);
    const member = edit(slides.find((s) => s.layout === "team")!, false);
    expect(member).not.toContain(EDITOR_WORDS.addPerson);
    expect(member).not.toContain(STUDIO_WORDS.insertNumber);
    expect(member).toContain("Sam Rivera");
  });
});
