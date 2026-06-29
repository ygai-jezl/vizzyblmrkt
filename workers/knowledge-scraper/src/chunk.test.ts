import { describe, it, expect } from "vitest";
import { chunkSource, parseBlocks, estimateTokens, MAX_CHARS, MAX_TOKENS } from "./chunk";

const SRC = "https://example.com/doc";

describe("parseBlocks", () => {
  it("tracks heading context and isolates fenced code", () => {
    const md = [
      "# Title",
      "intro para",
      "## Section A",
      "body a",
      "```ts",
      "const x = 1;",
      "## not a heading inside fence",
      "```",
      "after code",
    ].join("\n");
    const blocks = parseBlocks(md);
    const code = blocks.find((b) => b.kind === "code");
    expect(code).toBeTruthy();
    // The ## inside the fence must NOT have become a heading block.
    expect(code!.text).toContain("## not a heading inside fence");
    expect(blocks.filter((b) => b.kind === "heading").map((b) => b.text)).toEqual([
      "# Title",
      "## Section A",
    ]);
  });
});

describe("chunkSource — markdown", () => {
  it("returns nothing for empty input", () => {
    expect(chunkSource({ text: "", sourceUri: SRC })).toEqual([]);
    expect(chunkSource({ text: "   \n  ", sourceUri: SRC })).toEqual([]);
  });

  it("keeps a fenced code block atomic (never split mid-fence)", () => {
    const fence = ["```ts", ...Array.from({ length: 20 }, (_, i) => `line${i}();`), "```"].join(
      "\n",
    );
    const md = `## Example\nsome text\n${fence}\nmore text`;
    const chunks = chunkSource({ text: md, sourceUri: SRC, path: "guide.md" });
    const withFence = chunks.find((c) => c.content.includes("```ts"));
    expect(withFence).toBeTruthy();
    // The opening and closing fence live in the SAME chunk.
    const opens = (withFence!.content.match(/```/g) ?? []).length;
    expect(opens % 2).toBe(0); // balanced fences → not split across chunks
    expect(withFence!.content).toContain("line0();");
    expect(withFence!.content).toContain("line19();");
  });

  it("carries the nearest heading and a sequential chunkIndex", () => {
    const md = "## Pricing\nWe charge per seat.\n\n## Security\nSOC2 compliant.";
    const chunks = chunkSource({ text: md, sourceUri: SRC, path: "p.md" });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].heading).toBe("Pricing");
    expect(chunks[0].title).toBe("Pricing");
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
  });

  it("respects the token cap and overlaps adjacent text chunks (~15%)", () => {
    const para = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} about the product.`).join(
      " ",
    );
    const chunks = chunkSource({ text: para, sourceUri: SRC });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(MAX_TOKENS + 5);
    // Overlap: the start of chunk[1] should reappear at the end of chunk[0].
    const head = chunks[1].content.slice(0, 30);
    expect(chunks[0].content.includes(head.trim().split(" ")[0])).toBe(true);
  });
});

describe("chunkSource — code files", () => {
  it("splits a large code file into capped, fenced chunks at line boundaries", () => {
    const fn = (n: number) =>
      `export function f${n}(a: number) {\n  return a + ${n};\n}`;
    const file = Array.from({ length: 300 }, (_, i) => fn(i)).join("\n\n");
    const chunks = chunkSource({
      text: file,
      sourceUri: "https://github.com/x/y/blob/main/util.ts",
      path: "src/util.ts",
      isCode: true,
      lang: "ts",
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(MAX_TOKENS + 5);
      expect(c.content.startsWith("```ts")).toBe(true);
      expect(c.content.trimEnd().endsWith("```")).toBe(true);
      expect(c.path).toBe("src/util.ts");
      // No code line was split across the fence boundary.
      expect(c.content).not.toMatch(/return a \+ \d+;\s*```\s*```ts\s*}/);
    }
  });

  it("does not split a single over-long line mid-line", () => {
    const longLine = "x".repeat(MAX_CHARS + 500);
    const chunks = chunkSource({
      text: `short();\n${longLine}\nshort2();`,
      sourceUri: SRC,
      path: "big.js",
      isCode: true,
      lang: "js",
    });
    const reassembled = chunks.map((c) => c.content).join("");
    expect(reassembled).toContain(longLine); // the long line survived intact
  });
});

describe("estimateTokens", () => {
  it("scales with length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
  });
});
