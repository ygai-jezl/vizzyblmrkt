import { describe, expect, it } from "vitest";
import { chooseLinkTargets, isLinkablePage, linkIntent, linkLabel, pagesFromRepoPaths, routeFromRepoPath } from "./links";

describe("internal link targets", () => {
  it("sorts a page by what it is for", () => {
    expect(linkIntent("https://acme.example/pricing")).toBe("convert");
    expect(linkIntent("https://acme.example/book-a-demo")).toBe("convert");
    expect(linkIntent("https://acme.example/acme-vs-rivalco")).toBe("compare");
    expect(linkIntent("https://acme.example/customers/harbor")).toBe("proof");
    expect(linkIntent("https://acme.example/features/alerts")).toBe("product");
    expect(linkIntent("https://acme.example/blog/how-to-start")).toBe("learn");
    // A blog post reads, whatever it is called — unless it is a comparison or a customer story.
    expect(linkIntent("https://acme.example/blog/pricing", "Our new pricing")).toBe("learn");
    expect(linkIntent("https://acme.example/blog/acme-vs-rivalco")).toBe("compare");
    // The title decides when the path says nothing.
    expect(linkIntent("https://acme.example/p/123", "Request a demo")).toBe("convert");
  });

  it("labels a link from the page's title, or its path", () => {
    expect(linkLabel("https://acme.example/pricing", "Pricing | Acme")).toBe("Pricing");
    expect(linkLabel("https://acme.example/how-it-works", "")).toBe("How it works");
    expect(linkLabel("https://acme.example/", "")).toBe("Home");
  });

  it("never sends a reader to a utility page or the source code", () => {
    expect(isLinkablePage("https://acme.example/pricing")).toBe(true);
    expect(isLinkablePage("https://acme.example/login")).toBe(false);
    expect(isLinkablePage("https://acme.example/privacy")).toBe(false);
    expect(isLinkablePage("https://acme.example/sitemap.xml")).toBe(false);
    expect(isLinkablePage("http://acme.example/pricing")).toBe(false);
    expect(isLinkablePage("https://github.com/acme/app/blob/HEAD/src/app/pricing/page.tsx")).toBe(false);
  });

  it("chooses conversion pages first, then pages that go deeper on the topic", () => {
    const pages = [
      { url: "https://acme.example/", title: "Acme" },
      { url: "https://acme.example/blog/old-pricing-update", title: "Pricing update" },
      { url: "https://acme.example/blog/citation-gaps", title: "Citation gaps, explained | Acme" },
      { url: "https://acme.example/blog/unrelated", title: "Something else" },
      { url: "https://acme.example/pricing/", title: "Pricing | Acme" },
      { url: "https://acme.example/pricing#faq", title: "Pricing FAQ" },
      { url: "https://acme.example/demo", title: "Book a demo" },
      { url: "https://acme.example/product", title: "Product" },
      { url: "https://acme.example/login", title: "Log in" },
      { url: "https://acme.example/blog/this-article", title: "This article" },
    ];
    const chosen = chooseLinkTargets(pages, {
      related: ["https://acme.example/blog/citation-gaps", "https://acme.example/blog/this-article"],
      exclude: ["https://acme.example/blog/this-article"],
    });
    expect(chosen.map((l) => `${l.intent}:${l.url}`)).toEqual([
      "convert:https://acme.example/demo",
      "convert:https://acme.example/pricing",
      "product:https://acme.example/product",
      "learn:https://acme.example/blog/citation-gaps",
    ]);
    expect(chosen.every((l) => l.by === "research")).toBe(true);
    expect(chosen.find((l) => l.url.endsWith("/citation-gaps"))!.label).toBe("Citation gaps, explained");
  });

  it("reads a public route off a repo's page files", () => {
    expect(routeFromRepoPath("src/app/pricing/page.tsx")).toBe("/pricing");
    expect(routeFromRepoPath("src/app/page.tsx")).toBe("/");
    expect(routeFromRepoPath("apps/web/app/(marketing)/features/alerts/page.mdx")).toBe("/features/alerts");
    expect(routeFromRepoPath("src/app/[locale]/blog/page.tsx")).toBe("/blog");
    expect(routeFromRepoPath("pages/pricing.tsx")).toBe("/pricing");
    expect(routeFromRepoPath("src/pages/docs/index.astro")).toBe("/docs");
    expect(routeFromRepoPath("src/routes/pricing/+page.svelte")).toBe("/pricing");
    // No fixed URL, not public, or not a page at all.
    expect(routeFromRepoPath("src/app/[locale]/blog/[slug]/page.tsx")).toBeNull();
    expect(routeFromRepoPath("src/app/admin/settings/page.tsx")).toBeNull();
    expect(routeFromRepoPath("src/app/api/health/route.ts")).toBeNull();
    expect(routeFromRepoPath("src/app/@modal/login/page.tsx")).toBeNull();
    expect(routeFromRepoPath("pages/_app.tsx")).toBeNull();
    expect(routeFromRepoPath("pages/api/hello.ts")).toBeNull();
    expect(routeFromRepoPath("src/lib/pricing.ts")).toBeNull();
  });

  it("turns repo routes into candidate pages on the brand's site, conversion pages first", () => {
    const pages = pagesFromRepoPaths(
      ["src/app/blog/page.tsx", "src/app/pricing/page.tsx", "src/app/pricing/page.tsx", "src/app/admin/page.tsx", "README.md"],
      "https://acme.example/some/path",
    );
    expect(pages.map((p) => p.url)).toEqual(["https://acme.example/pricing", "https://acme.example/blog"]);
    expect(pagesFromRepoPaths(["src/app/pricing/page.tsx"], "http://acme.example")).toEqual([]);
    expect(pagesFromRepoPaths(["src/app/pricing/page.tsx"], "")).toEqual([]);
  });
});
