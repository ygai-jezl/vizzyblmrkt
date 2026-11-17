import { describe, expect, it } from "vitest";
import { chunkText, contentHash, localWordsScore, markdownToText, queryTerms, reciprocalRankFusion, toPlainText, wordsQueries } from "./text";

describe("toPlainText", () => {
  it("drops Markdown and HTML markup but keeps the words", () => {
    expect(markdownToText("# Repotting\n\nUse the **FL-204** [kit](https://example.com/kit).")).toBe("Repotting\n\nUse the FL-204 kit.");
    expect(toPlainText("<p>Water <b>less</b> in winter</p><p>More in spring</p>", "html")).toBe("Water less in winter\nMore in spring");
    expect(toPlainText("  plain   text  ")).toBe("plain text");
  });
});

describe("chunkText", () => {
  it("keeps short text whole and splits long text at paragraphs with an overlap", () => {
    expect(chunkText("short")).toEqual(["short"]);
    expect(chunkText("")).toEqual([]);
    const para = (n: number) => `Paragraph ${n}. ` + "word ".repeat(150).trim() + ".";
    const text = [1, 2, 3, 4].map(para).join("\n\n");
    const chunks = chunkText(text, 1200, 150);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1200);
    expect(chunks.join(" ")).toContain("Paragraph 4.");
  });
});

describe("contentHash", () => {
  it("changes with any part and is stable otherwise", () => {
    expect(contentHash("m", "t", ["a", "b"])).toBe(contentHash("m", "t", ["a", "b"]));
    expect(contentHash("m", "t", ["a", "b"])).not.toBe(contentHash("m", "t", ["a", "c"]));
    expect(contentHash("m", "t", ["ab"])).not.toBe(contentHash("m", "t", ["a", "b"]));
  });
});

describe("words queries", () => {
  it("drops stop words and the OR the database doesn't support, and keeps codes and phrases", () => {
    expect(queryTerms('What "repotting kit" do I need for FL-204 OR returns?')).toEqual(['"repotting kit"', "fl-204", "returns"]);
  });

  it("asks for every term together, then each long term alone", () => {
    expect(wordsQueries("what kit do I need for returns")).toEqual(["kit returns", "returns", "kit"]);
    expect(wordsQueries("FL-204")).toEqual(["fl-204"]);
    expect(wordsQueries("the and of")).toEqual([]);
  });
});

describe("localWordsScore (the emulator stand-in)", () => {
  const doc = { title: "Repotting a fiddle leaf fig", text: "The FL-204 repotting kit has the pot, soil and gloves." };

  it("needs every term, like Firestore's text search", () => {
    expect(localWordsScore("repot", doc)).toBeGreaterThan(0);
    expect(localWordsScore("kits", doc)).toBeGreaterThan(0);
    expect(localWordsScore("fl204", doc)).toBeGreaterThan(0);
    expect(localWordsScore("fl-204 gloves", doc)).toBeGreaterThan(0);
    expect(localWordsScore("gloves citrus", doc)).toBe(0);
    expect(localWordsScore('"repotting kit"', doc)).toBeGreaterThan(0);
    expect(localWordsScore('"kit repotting"', doc)).toBe(0);
  });

  it("counts a title hit more than a body hit", () => {
    expect(localWordsScore("fiddle", doc)).toBeGreaterThan(localWordsScore("gloves", doc));
  });
});

describe("reciprocalRankFusion", () => {
  it("puts what both lists rank high first", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "d", "a"],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "d", "c"]);
  });

  it("lets a list count more", () => {
    const lists = [
      ["b", "a"],
      ["a", "b"],
    ];
    expect(reciprocalRankFusion(lists)[0]?.id).toBe("a");
    expect(reciprocalRankFusion(lists, [3, 1])[0]?.id).toBe("b");
  });

  it("counts an id once per list", () => {
    const fused = reciprocalRankFusion([["a", "a", "a"]]);
    expect(fused).toEqual([{ id: "a", score: 1 / 61 }]);
  });
});
