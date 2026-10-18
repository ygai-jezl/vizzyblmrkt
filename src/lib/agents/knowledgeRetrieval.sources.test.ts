import { describe, expect, it } from "vitest";
import { isCodeHostUrl } from "@/lib/content/blog/brief";
import { formatContext, withoutSources, type RetrievedChunk } from "./knowledgeRetrieval";

const chunk = (title: string, sourceUri: string, content: string): RetrievedChunk => ({ title, sourceUri, content, path: null, heading: null, topic: null, tags: [] });

describe("reference material without some sources", () => {
  const docs = chunk("Pricing", "https://acme.example/pricing", "Every plan includes weekly runs.");
  const repo = chunk("README", "https://github.com/acme/app/blob/HEAD/README.md", "Prompts are deduplicated by a hash.\n\nTemplates stay pending.");
  const blog = chunk("Blog", "https://acme.example/blog/x", "Daily runs suit launches.");

  it("leaves out the blocks from the sources it is told to, and keeps the rest as they were", () => {
    const formatted = formatContext([docs, repo, blog]);
    const out = withoutSources(formatted, isCodeHostUrl);
    expect(out).not.toContain("deduplicated");
    expect(out).not.toContain("Templates stay pending");
    expect(out).toBe(formatContext([docs, blog]));
  });

  it("is unchanged when nothing matches, and empty when nothing is left", () => {
    const formatted = formatContext([docs, blog]);
    expect(withoutSources(formatted, isCodeHostUrl)).toBe(formatted);
    expect(withoutSources(formatContext([repo]), isCodeHostUrl)).toBe("");
    expect(withoutSources("plain text", isCodeHostUrl)).toBe("plain text");
  });
});
