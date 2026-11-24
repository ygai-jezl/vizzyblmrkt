import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LegalDoc } from "./LegalDoc";

const html = (md: string) => renderToStaticMarkup(createElement(LegalDoc, { markdown: md }));

describe("LegalDoc", () => {
  it("renders headings, emphasis and links", () => {
    const out = html("# Title\n\n## Part\n\n### 1. Clause\n\n*Updated* and **bold** [terms](/terms).");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<h2>Part</h2>");
    expect(out).toContain("<h3>1. Clause</h3>");
    expect(out).toContain("<em>Updated</em>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain('<a href="/terms">terms</a>');
  });

  it("renders lists and tables with a header row", () => {
    const out = html("- one\n- two\n\n| Who | Why |\n| --- | --- |\n| Example Ltd | Hosting |\n");
    expect(out).toMatch(/<ul><li><p>.*one.*<\/p><\/li>/);
    expect(out).toContain("<thead><tr><th><p>Who</p></th>");
    expect(out).toContain("<tbody><tr><td><p>Example Ltd</p></td>");
  });

  it("drops links that are not web, mail or site links", () => {
    const out = html("[x](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
  });
});
