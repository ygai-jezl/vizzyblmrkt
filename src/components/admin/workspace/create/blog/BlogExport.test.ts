import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlogBriefSchema } from "@/lib/types/contentPlan";
import { BlogExport } from "./BlogExport";

const ARTICLE = "# How do you pick a CRM?\n\nStart with the team.\n\n## What does it cost?\n\nLess than you think.";
const URL_ = "https://acme.example/blog/pick-a-crm";

const html = (opts: { approved?: boolean; pageUrl?: string | null; publisherName?: string } = {}) =>
  renderToStaticMarkup(
    createElement(BlogExport, {
      markdown: ARTICLE,
      meta: null,
      onMetaChange: () => {},
      brief: BlogBriefSchema.parse({ publisherName: opts.publisherName ?? "" }),
      pageUrl: opts.pageUrl === undefined ? URL_ : opts.pageUrl,
      brandName: "Acme",
      logoUrl: null,
      approved: opts.approved ?? true,
    }),
  );

describe("BlogExport: Summarize with AI", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("shows nothing new while the switch is off", () => {
    const out = html();
    expect(out).not.toContain("Summarize with AI");
    expect(out).not.toContain("chatgpt.com");
    expect(out).toContain("Copy Markdown");
  });

  describe("switch on", () => {
    beforeEach(() => vi.stubEnv("NEXT_PUBLIC_BLOG_AI_SUMMARY_LINKS_ENABLED", "true"));

    it("asks for approval first", () => {
      const out = html({ approved: false });
      expect(out).toContain("Approve the article to get its Summarize with AI links.");
      expect(out).not.toContain("chatgpt.com");
    });

    it("asks for the article's address, or its own https one", () => {
      expect(html({ pageUrl: null })).toContain("Add the article&#x27;s address to make its links.");
      expect(html({ pageUrl: "http://acme.example/blog/pick-a-crm" })).toContain(
        "Use the article&#x27;s own https address to make its links.",
      );
      expect(html({ pageUrl: "https://acme.example/" })).toContain("Use the article&#x27;s own https address to make its links.");
    });

    it("gives an approved article at its address its prompt, four links and the copy buttons", () => {
      const out = html();
      expect(out).toContain(`Summarize and analyze the key insights from ${URL_}, the Acme article &quot;How do you pick a CRM?&quot;.`);
      expect(out).toContain("Cover: What does it cost.");
      for (const host of ["https://chatgpt.com/", "https://claude.ai/new", "https://www.perplexity.ai/search/new", "https://www.google.com/search"]) {
        expect(out).toContain(`href="${host}`);
      }
      expect(out).not.toMatch(/gemini/i);
      expect(out).toContain("Copy buttons HTML");
      expect(out).toContain("Copy links Markdown");
    });

    it("cites the brief's publisher when it names one", () => {
      expect(html({ publisherName: "Acme Labs" })).toContain("Cite Acme Labs as the source");
    });
  });
});
