import { describe, expect, it } from "vitest";
import { dashesIn } from "@/lib/content/writingRules";
import { changeProblems, hrefsIn, tokensIn } from "./vizzyChecks";

const base = { format: "email" as const, shape: "inline" as const, instruction: "make it friendlier" };

describe("merge values", () => {
  it("finds each value once, including a fallback", () => {
    expect(tokensIn("Hi {{first_name}}, {{user.first_name|there}} and {{first_name}}")).toEqual([
      "{{first_name}}",
      "{{user.first_name|there}}",
    ]);
  });

  it("stops a change that drops or makes up a value", () => {
    expect(changeProblems({ ...base, before: "Hi {{first_name}},", after: "Hello there," }).hard[0]).toBe(
      "Vizzy's version dropped {{first_name}}, so it wasn't used.",
    );
    expect(changeProblems({ ...base, before: "Hi there,", after: "Hi {{surname}}," }).hard[0]).toContain("added {{surname}}");
  });

  it("lets a value come or go when the person names it, or when it's one this email may use", () => {
    expect(changeProblems({ ...base, instruction: "remove {{first_name}}", before: "Hi {{first_name}},", after: "Hi," }).hard).toEqual([]);
    expect(changeProblems({ ...base, allowedTokens: ["{{first_name}}"], before: "Hi,", after: "Hi {{first_name}}," }).hard).toEqual([]);
  });

  it("keeps a block value on a line of its own", () => {
    const after = "<p>Here is your list.</p>\n<p>{{block.checklist}}</p>";
    expect(changeProblems({ ...base, shape: "blocks", before: after, after }).hard).toEqual([]);
    expect(
      changeProblems({ ...base, shape: "blocks", before: after, after: "<p>Your list: {{block.checklist}}</p>" }).hard[0],
    ).toContain("block value");
  });
});

describe("links", () => {
  it("reads Markdown and email links", () => {
    expect(hrefsIn("blog", "See [the guide](/guide) and [x](https://example.com/a).")).toEqual(["/guide", "https://example.com/a"]);
    expect(hrefsIn("email", '<a href="{{hub_url}}">Read</a> <a href=\'mailto:a@example.com\'>m</a>')).toEqual([
      "{{hub_url}}",
      "mailto:a@example.com",
    ]);
  });

  it("stops a lost or new link, unless the person asked about links or the text already has it", () => {
    const md = { format: "blog" as const, shape: "inline" as const, instruction: "shorter" };
    expect(changeProblems({ ...md, before: "See [the guide](/guide).", after: "See the guide." }).hard[0]).toContain("dropped the link to /guide");
    expect(changeProblems({ ...md, instruction: "remove the link", before: "See [the guide](/guide).", after: "See it." }).hard).toEqual([]);
    expect(changeProblems({ ...md, before: "See it.", after: "See [it](https://evil.example)." }).hard[0]).toContain("added a link");
    expect(changeProblems({ ...md, docHrefs: ["/pricing"], before: "See it.", after: "See [it](/pricing)." }).hard).toEqual([]);
  });
});

describe("the rest", () => {
  const md = { format: "blog" as const, instruction: "tidy" };

  it("stops a changed code block and a second paragraph in a line", () => {
    const code = "```bash\nnpm test\n```";
    expect(changeProblems({ ...md, shape: "blocks", before: `Run:\n\n${code}`, after: "Run:\n\n```bash\nnpm t\n```" }).hard[0]).toContain(
      "code block",
    );
    expect(changeProblems({ ...md, shape: "inline", before: "One.", after: "One.\n\nTwo." }).hard[0]).toContain("more than one paragraph");
  });

  it("warns about new AI tells and dashes only", () => {
    const r = changeProblems({ ...md, shape: "inline", before: "We leverage data.", after: "We leverage seamless data — fast." });
    expect(r.hard).toEqual([]);
    expect(r.soft).toEqual(['It uses "seamless", which reads as AI writing.', "It uses a dash as punctuation."]);
  });

  it("warns when the change repeats the words around it", () => {
    const r = changeProblems({
      ...md,
      shape: "inline",
      contextBefore: "This plan splits the work into four weeks.",
      before: "Most launches slip.",
      after: "This plan splits the work into four weeks. Most launches slip.",
    });
    expect(r.soft).toContain("It repeats words from around your selection.");
  });

  it("warns when a table or box goes", () => {
    const before = "> **TL;DR**\n>\n> Short.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(changeProblems({ ...md, shape: "blocks", before, after: "Short. A is 1 and B is 2." }).soft).toEqual([
      "It removed a table.",
      "It removed a box.",
    ]);
  });

  it("refuses email HTML Edit mode can't keep", () => {
    expect(changeProblems({ ...base, before: "<p>Hi</p>", after: '<p>Hi <img src="x.png"></p>' }).hard[0]).toContain("an image");
  });
});

describe("dashes", () => {
  it("finds dashes used as punctuation, not in words, ranges or lists", () => {
    expect(dashesIn("features—such as tracking")).toHaveLength(1);
    expect(dashesIn("one – two")).toHaveLength(1);
    expect(dashesIn("this - that")).toHaveLength(1);
    expect(dashesIn("a follow-up in 2024-2026 or 2024–2026\n- item")).toEqual([]);
  });
});
