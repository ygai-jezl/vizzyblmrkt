import { describe, expect, it, vi } from "vitest";
import { dataForSeoConfigured, getSerpTask, isOwnHost, parseSerp, postSerpTask, unwrapGoogleUrl, type DataForSeoFetch } from "./dataforseo";
import { envelope, SERP_RESULT } from "./testing/serpFixture";

const ENV = { DATAFORSEO_USERNAME: "api-user@example.com", DATAFORSEO_PASSWORD: "not-a-real-password" };
const US = { country: "US", language: "en" };

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the DataForSEO client", () => {
  it("knows when it has no login, and never calls without one", async () => {
    expect(dataForSeoConfigured({})).toBe(false);
    expect(dataForSeoConfigured({ DATAFORSEO_USERNAME: "u", DATAFORSEO_PASSWORD: " " })).toBe(false);
    expect(dataForSeoConfigured(ENV)).toBe(true);
    const fetch = vi.fn<DataForSeoFetch>();
    expect(await postSerpTask("How?", US, { tag: "sig_1", priority: 2 }, { env: {}, fetch })).toEqual({ ok: false, error: "not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts one task for the market with the login, and keeps its id and cost", async () => {
    const fetch = vi.fn<DataForSeoFetch>(async () => answer(envelope({ id: "11111111-2222-3333", status_code: 20100, cost: 0.0012 })));
    const got = await postSerpTask("  How do I get cited by AI answers?  ", { country: "GB", language: "en" }, { tag: "sig_1", priority: 2 }, { env: ENV, fetch });
    expect(got).toEqual({ ok: true, taskId: "11111111-2222-3333", cost: 0.0012 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.dataforseo.com/v3/serp/google/organic/task_post");
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`${ENV.DATAFORSEO_USERNAME}:${ENV.DATAFORSEO_PASSWORD}`).toString("base64")}`);
    expect(JSON.parse(String(init.body))).toEqual([
      expect.objectContaining({ keyword: "How do I get cited by AI answers?", location_code: 2826, language_code: "en", depth: 10, people_also_ask_click_depth: 2, priority: 2, tag: "sig_1" }),
    ]);
  });

  it("refuses a market it doesn't know, and reports DataForSEO's refusals by code only", async () => {
    const fetch = vi.fn<DataForSeoFetch>(async () => answer(envelope({ id: "x", status_code: 40501 })));
    expect(await postSerpTask("How?", { country: "XX", language: "en" }, { tag: "t", priority: 1 }, { env: ENV, fetch })).toEqual({ ok: false, error: "unknown_market" });
    expect(await postSerpTask("How?", US, { tag: "t", priority: 1 }, { env: ENV, fetch })).toEqual({ ok: false, error: "dataforseo_40501" });
    fetch.mockResolvedValueOnce(answer({}, 401));
    expect(await postSerpTask("How?", US, { tag: "t", priority: 1 }, { env: ENV, fetch })).toEqual({ ok: false, error: "login_refused" });
    fetch.mockResolvedValueOnce(answer({ status_code: 40200, tasks: [] }));
    expect(await postSerpTask("How?", US, { tag: "t", priority: 1 }, { env: ENV, fetch })).toEqual({ ok: false, error: "dataforseo_40200" });
  });

  it("never passes on a network error whole, since it can carry the login", async () => {
    const fetch = vi.fn<DataForSeoFetch>(async () => {
      throw new Error(`failed with Basic ${ENV.DATAFORSEO_PASSWORD}`);
    });
    const got = await postSerpTask("How?", US, { tag: "t", priority: 1 }, { env: ENV, fetch });
    expect(got).toEqual({ ok: false, error: "network" });
    expect(JSON.stringify(got)).not.toContain(ENV.DATAFORSEO_PASSWORD);
  });

  it("collects a task, says when it isn't ready, and checks the task id", async () => {
    const fetch = vi.fn<DataForSeoFetch>(async () => answer(envelope({ id: "abcdefgh-1", status_code: 20000, cost: 0, result: [SERP_RESULT] })));
    expect(await getSerpTask("abcdefgh-1", { env: ENV, fetch })).toEqual({ ok: true, raw: SERP_RESULT, cost: 0 });
    expect(fetch.mock.calls[0]![0]).toBe("https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/abcdefgh-1");
    fetch.mockResolvedValueOnce(answer(envelope({ id: "abcdefgh-1", status_code: 40602 })));
    expect(await getSerpTask("abcdefgh-1", { env: ENV, fetch })).toEqual({ ok: false, notReady: true });
    expect(await getSerpTask("../../v3/user", { env: ENV, fetch })).toEqual({ ok: false, error: "bad_task_id" });
  });
});

describe("reading Google's results", () => {
  const read = parseSerp(SERP_RESULT, ["brand.example.com"]);

  it("keeps the top results with their positions, and finds the brand's own page on a subdomain", () => {
    expect(read.results.top.map((r) => [r.position, r.domain])).toEqual([
      [1, "rival-a.test"],
      [2, "forum.test"],
      [3, "blog.brand.example.com"],
    ]);
    expect(read.numbers.googlePosition).toBe(3);
  });

  it("keeps People also ask once each, with the page that answers when Google gave one", () => {
    expect(read.results.paa).toEqual([
      { question: "How does ChatGPT choose which sources to cite?", url: "https://rival-b.test/how-it-chooses", domain: "rival-b.test" },
      { question: "Does ChatGPT cite recent content more often?", url: "https://news.test/recent", domain: "news.test" },
      { question: "What makes a page easy to quote?", url: null, domain: null },
    ]);
    expect(read.numbers.peopleAlsoAsk).toBe(3);
  });

  it("keeps also searched and related searches, whether Google listed words or titles", () => {
    expect(read.results.alsoSearched).toEqual(["get cited by chatgpt step by step", "ai citations checklist"]);
    expect(read.results.related).toEqual(["chatgpt sources", "perplexity citations"]);
  });

  it("keeps the AI Overview's cited pages, unwraps Google's links, and sees when it cites the brand", () => {
    expect(read.results.aiOverview?.cites.map((c) => c.url)).toEqual([
      "https://rival-a.test/blog/cited",
      "https://forum.test/t/1",
      "https://www.brand.example.com/guide",
    ]);
    expect(read.numbers).toMatchObject({ aiOverviewSources: 3, aiOverviewCitesYou: true });
  });

  it("says nothing it didn't see: no AI Overview, no own site, nothing at all", () => {
    const noAio = { ...SERP_RESULT, items: SERP_RESULT.items.filter((i) => i.type !== "ai_overview") };
    expect(parseSerp(noAio, []).numbers).toEqual({ googlePosition: null, peopleAlsoAsk: 3, aiOverviewSources: 0, aiOverviewCitesYou: null });
    expect(parseSerp(null, ["brand.example.com"])).toEqual({
      numbers: { googlePosition: null, peopleAlsoAsk: 0, aiOverviewSources: 0, aiOverviewCitesYou: null },
      results: { top: [], paa: [], alsoSearched: [], related: [], aiOverview: null },
    });
  });

  it("matches own hosts exactly or as subdomains, never as look-alikes", () => {
    expect(isOwnHost("www.brand.example.com", ["brand.example.com"])).toBe(true);
    expect(isOwnHost("notbrand.example.com", ["brand.example.com"])).toBe(false);
    expect(unwrapGoogleUrl("https://www.google.co.uk/url?q=https://a.test/x")).toBe("https://a.test/x");
    expect(unwrapGoogleUrl("https://a.test/url?q=https://b.test")).toBe("https://a.test/url?q=https://b.test");
  });
});
