import { describe, it, expect } from "vitest";
import { capitalisedNames, validateAiLine, validateAiSubject } from "./insightValidator";

const allowed = ["Vizzybl", "Share of voice", "ChatGPT", "AI answers"];

describe("validateAiLine", () => {
  it("accepts a plain, fact-free line", () => {
    expect(validateAiLine("That's a strong start — the prompts you monitor next will show where you can grow.", allowed)).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("rejects digits and spelled-out quantities", () => {
    expect(validateAiLine("You could reach 40% next week.", allowed).ok).toBe(false);
    expect(validateAiLine("That is twice what most brands see.", allowed).ok).toBe(false);
    expect(validateAiLine("Three quick fixes would help.", allowed).issues.join(" ")).toMatch(/quantity/);
  });

  it("rejects links, domains and email addresses", () => {
    expect(validateAiLine("See https://example.com for more.", allowed).ok).toBe(false);
    expect(validateAiLine("Check example.com today.", allowed).ok).toBe(false);
    expect(validateAiLine("Write to help@vizzybl.ai with questions.", allowed).ok).toBe(false);
  });

  it("rejects promises and markup", () => {
    expect(validateAiLine("We guarantee better rankings.", allowed).ok).toBe(false);
    expect(validateAiLine("Become the #1 answer.", allowed).ok).toBe(false);
    expect(validateAiLine("Try {{user.first_name}} now.", allowed).ok).toBe(false);
    expect(validateAiLine("A <b>bold</b> move.", allowed).ok).toBe(false);
  });

  it("rejects names that aren't in the facts or glossary, anywhere in the line", () => {
    const r = validateAiLine("Your rivals on Perplexity are catching up.", allowed);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toContain('"Perplexity"');
    // A name at the start of a sentence is still a name when it's clearly one.
    expect(validateAiLine("GitHub shows the same pattern.", allowed).ok).toBe(false);
    expect(validateAiLine("Google Search does this too.", allowed).ok).toBe(false);
  });

  it("allows the product, glossary and fact names, and ordinary sentence starts", () => {
    expect(validateAiLine("Keep an eye on how ChatGPT describes you in AI answers.", allowed).ok).toBe(true);
    expect(validateAiLine("Vizzybl tracks this for you every day.", allowed).ok).toBe(true);
    expect(validateAiLine("Great work. Next, look at your share of voice.", allowed).ok).toBe(true);
  });

  it("caps the length at 40 words", () => {
    const long = Array.from({ length: 41 }, () => "word").join(" ");
    expect(validateAiLine(long, allowed).ok).toBe(false);
  });
});

describe("validateAiSubject", () => {
  it("applies the same rules plus a 60-character limit", () => {
    expect(validateAiSubject("Where ChatGPT sees you", allowed).ok).toBe(true);
    expect(validateAiSubject("Your 3 quick wins", allowed).ok).toBe(false);
    expect(validateAiSubject("x".repeat(61), allowed).ok).toBe(false);
  });
});

describe("capitalisedNames", () => {
  it("groups runs and skips ordinary sentence starts", () => {
    expect(capitalisedNames("Nice. Ask Google Search and Bing, then compare.")).toEqual(["Google Search", "Bing"]);
    expect(capitalisedNames("I think this helps.")).toEqual([]);
  });
});
