import { describe, expect, it } from "vitest";
import { profileLinksFromHtml } from "./profileLinks";

const HTML = `
<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme","sameAs":["https://www.linkedin.com/company/acme-example/","https://www.wikidata.org/wiki/Q42"]}]}</script>
<script type="application/ld+json">not json</script>
</head><body>
<a href="https://twitter.com/intent/tweet?text=hi">Share</a>
<a href="https://www.linkedin.com/shareArticle?url=x">Share on LinkedIn</a>
<a href="https://uk.linkedin.com/company/acme-example">LinkedIn again</a>
<a href="https://x.com/acme_example">X</a>
<a href="https://x.com/someone_else/status/123">A post</a>
<a href="https://www.youtube.com/@acme-example?si=abc">YouTube</a>
<a href="https://github.com/acme-example">GitHub</a>
<a href="https://acme.example/about">About</a>
<a href="/careers">Careers</a>
<a href="https://www.facebook.com/sharer/sharer.php?u=x">Share on Facebook</a>
</body></html>`;

describe("profile links on the brand's own home page", () => {
  it("takes its own markup's sameAs first, then links to profile sites, one per site", () => {
    expect(profileLinksFromHtml(HTML, "https://acme.example/", ["acme.example"])).toEqual([
      "https://www.linkedin.com/company/acme-example",
      "https://www.wikidata.org/wiki/Q42",
      "https://x.com/acme_example",
      "https://www.youtube.com/@acme-example",
      "https://github.com/acme-example",
    ]);
  });

  it("finds nothing on a page with no profile links", () => {
    expect(profileLinksFromHtml("<a href='/pricing'>Pricing</a>", "https://acme.example", ["acme.example"])).toEqual([]);
  });
});
