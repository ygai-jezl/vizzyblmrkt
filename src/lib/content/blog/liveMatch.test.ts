import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { markdownToText } from "@/lib/search/text";
import { checkLive, decodeHtmlEntities, pageMatches, setArticleLive, textShare } from "./live";
import { readH1 } from "./research";
import { sampleHub, samplePlan } from "./testing/samplePlan";
import { SAMPLE_ARTICLE } from "./testing/sampleArticle";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const PLANS = "workspaces/ws1/content_plans";
const now = () => new Date("2026-11-21T10:00:00.000Z");
const TITLE = "What is AI search visibility monitoring?";
const SEO_TITLE = "AI Visibility Monitoring Explained | Acme";
const MENU = "Home Pricing Blog Customers Book a demo. Acme helps B2B teams see how AI answer engines talk about them.";
const FOOTER = "Subscribe to the Acme newsletter. Privacy Terms Contact. Copyright 2026 Acme Ltd.";
const articleText = markdownToText(SAMPLE_ARTICLE);
/** Another article on the same subject, written separately (shares words, not runs of them). */
const OTHER = [
  "Brands that track how AI assistants describe them tend to find gaps in their content first.",
  "An answer engine may name three vendors for a buying question, and the reasons it gives come from pages it can read.",
  "Teams that publish clear comparison pages, pricing pages and customer stories give those engines more to quote.",
  "A monthly review of the questions buyers ask, and of which pages get cited, keeps that work focused.",
  "Start with the ten questions your sales team hears most, then check which of them your site answers in plain words.",
].join(" ").repeat(3);

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the text check", () => {
  it("finds most of the article on its own page, menus and footer around it", () => {
    const r = textShare(SAMPLE_ARTICLE, `${MENU}\n${articleText}\n${FOOTER}`);
    expect(r.share).toBeGreaterThanOrEqual(0.9);
    expect(r.runs).toBeGreaterThan(100);
  });

  it("finds almost none of it on another article about the same subject, or on the blog's index", () => {
    expect(textShare(SAMPLE_ARTICLE, `${MENU}\n${OTHER}\n${FOOTER}`).share).toBeLessThan(0.05);
    const index = `${MENU}\n${TITLE} AI search visibility monitoring is the practice of measuring how often AI answer engines name a brand. Read more\n${FOOTER}`;
    expect(textShare(SAMPLE_ARTICLE, index).share).toBeLessThan(0.1);
  });

  it("reads past the entities sites leave in their text", () => {
    expect(decodeHtmlEntities("don&#x27;t &#8217;s &rsquo;x&lsquo; &amp; &unknown; &#99999999;")).toBe("don't \u2019s 'x' & &unknown;  ");
    const html = "It&#x27;s what AI answer engines don&#8217;t say about a brand that costs it the shortlist when buyers ask.";
    const md = "It's what AI answer engines don't say about a brand that costs it the shortlist when buyers ask.";
    expect(textShare(md, html).share).toBe(1);
  });

  it("knows the article by its heading when the site gives the page its own title", () => {
    expect(readH1(`<html><title>${SEO_TITLE}</title><h1 class="x">What is <em>AI search</em> visibility monitoring?</h1></html>`)).toBe(TITLE);
    // Half the article cut before it went up: a third of its runs are left.
    const edited = articleText.split("\n").filter((_, i) => i % 2 === 1).join("\n");
    const page = { title: SEO_TITLE, h1: TITLE, text: `${MENU}\n${edited}\n${FOOTER}` };
    const m = pageMatches(page, { titles: [TITLE, ""], body: SAMPLE_ARTICLE });
    expect(m.heading).toBe(true);
    expect(m.textShare).toBeGreaterThanOrEqual(0.2);
    expect(m.textShare).toBeLessThan(0.5);
    // An address a person saved: the heading and some of the text are enough.
    expect(m.matched).toBe(true);
    // A page nobody chose (the sitemap): most of the text, or nothing.
    expect(pageMatches(page, { titles: [TITLE], body: SAMPLE_ARTICLE }, { strict: true }).matched).toBe(false);
    expect(pageMatches({ ...page, text: articleText }, { titles: [TITLE], body: SAMPLE_ARTICLE }, { strict: true }).matched).toBe(true);
  });

  it("a page with the article's title but none of its text is not the article", () => {
    const m = pageMatches({ title: TITLE, h1: TITLE, text: `${MENU}\n${OTHER}` }, { titles: [TITLE], body: SAMPLE_ARTICLE });
    expect(m).toMatchObject({ heading: true, matched: false });
  });

  it("a short article is told by its heading", () => {
    const short = "# Pricing\n\nAcme costs 49 a month for a team of five.";
    expect(pageMatches({ title: "Plans | Acme", h1: "Pricing", text: "Other words" }, { titles: ["Pricing"], body: short }).matched).toBe(true);
    expect(pageMatches({ title: "Plans | Acme", h1: "Pricing", text: "Other words" }, { titles: ["Pricing"], body: short }, { strict: true }).matched).toBe(false);
  });

  it("says how much of the text it found, when it reads the text", async () => {
    const reader = async () => ({ title: SEO_TITLE, h1: TITLE, text: articleText });
    expect(await checkLive("https://acme.example/blog/visibility", [TITLE], reader, { body: SAMPLE_ARTICLE })).toMatchObject({
      reachable: true,
      matched: true,
      heading: true,
      textShare: 1,
    });
    // Without the article's text it compares titles only, as before.
    expect(await checkLive("https://acme.example/blog/visibility", [TITLE], reader)).toEqual({ reachable: true, refused: false, title: SEO_TITLE, matched: false });
  });
});

describe("Check it's live, with Found live on", () => {
  beforeEach(() => vi.stubEnv("BLOG_LIVE_WATCH_ENABLED", "true"));

  it("finds the article when the site gives the page its own title", async () => {
    const db = new FakeFirestore();
    const plan = samplePlan({}, sampleHub({ status: "approved" }));
    db.seed(PLANS, plan.id, plan);
    const reader = async () => ({ title: SEO_TITLE, h1: TITLE, text: `${MENU}\n${articleText}` });
    const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check" }, { db, now, fetchPage: reader });
    expect(r.ok && r.check).toMatchObject({ matched: true, textShare: 1 });
    expect(r.ok && r.node.blog?.live).toMatchObject({ by: "check", titleMatched: true, textShare: 1, found: "address" });
  });

  it("with the switch off, the same page is not found (titles only)", async () => {
    vi.stubEnv("BLOG_LIVE_WATCH_ENABLED", "");
    const db = new FakeFirestore();
    const plan = samplePlan({}, sampleHub({ status: "approved" }));
    db.seed(PLANS, plan.id, plan);
    const reader = async () => ({ title: SEO_TITLE, h1: TITLE, text: articleText });
    const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check" }, { db, now, fetchPage: reader });
    expect(r.ok && r.check).toEqual({ reachable: true, refused: false, title: SEO_TITLE, matched: false });
    expect(db.writeCountFor(PLANS, "plan_1")).toBe(0);
  });
});
