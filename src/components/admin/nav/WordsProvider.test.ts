import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ideaWord } from "@/lib/nav/terms";
import { useWords, WordsProvider } from "./WordsProvider";

/** A client component deep in a launch screen, naming the page the way the words say. */
function Title() {
  return createElement("h1", null, ideaWord(useWords().ideas).Many);
}

describe("WordsProvider", () => {
  it("hands the server's answer to the components inside it", () => {
    const inside = (ideas: boolean) =>
      renderToStaticMarkup(createElement(WordsProvider, { ideas } as Parameters<typeof WordsProvider>[0], createElement(Title)));
    expect(inside(true)).toBe("<h1>Ideas</h1>");
    expect(inside(false)).toBe("<h1>Launches</h1>");
  });

  it("says Launch outside it (nav v1, tests, anything the layout doesn't wrap)", () => {
    expect(renderToStaticMarkup(createElement(Title))).toBe("<h1>Launches</h1>");
  });
});
