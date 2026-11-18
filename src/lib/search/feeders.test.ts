import { describe, expect, it } from "vitest";
import type { BrandNote } from "@/lib/types/brandNote";
import type { Competitor, CompetitorArticle } from "@/lib/types/competitor";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { LifecycleJourney } from "@/lib/types/lifecycle";
import type { BrandSignal } from "@/lib/types/brandSignal";
import { brandKitSource, brandMapSource, brandMapStubs, broadcastSource, competitorSources, contentPlanSources, lifecycleSources, noteSource, signalSource, stubOf } from "./feeders";

const node = (over: Record<string, unknown>) => ({ id: "n", type: "spoke", channel: "linkedin", role: "Post", position: { x: 0, y: 0 }, body: "", status: "generated", placeholderValues: {}, warnings: [], ...over });

const plan = (over: Partial<ContentPlan> = {}): ContentPlan =>
  ({
    id: "plan_1",
    tenantId: "ten_fernleaf",
    workspaceId: "ws_1",
    name: "Spring repotting",
    status: "ready",
    topology: { hubChannel: "blog", spokeChannels: ["linkedin"] },
    graph: {
      nodes: [
        node({ id: "hub", type: "hub", channel: "blog", role: "Hub: Blog", body: "# Repotting\n\nUse the FL-204 kit." }),
        node({ id: "li", body: "Spring is repotting season." }),
        node({ id: "empty", body: "" }),
        node({ id: "em", type: "email", channel: "email", role: "Email 1", subject: "Your kit is here", body: "Open the box." }),
      ],
      edges: [],
    },
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
    ...over,
  }) as unknown as ContentPlan;

describe("contentPlanSources", () => {
  it("indexes the hub as an article, social posts and email steps, and skips empty nodes", () => {
    const out = contentPlanSources(plan());
    expect(out.map((s) => `${s.kind}:${s.ref}`)).toEqual(["article:plan_1", "post:plan_1/li", "journey_email:plan_1/em"]);
    expect(out[0]).toMatchObject({ format: "markdown", url: "/admin/workspace/ws_1/create/plan_1" });
    expect(out[2]?.title).toBe("Your kit is here");
  });

  it("indexes an ebook from its chapters, as HTML, at the ebook page", () => {
    const ebook = plan({
      topology: { hubChannel: "ebook", spokeChannels: [] },
      ebookDraft: { title: "The repotting book", subtitle: "", industryLens: "", chapters: [{ id: "c1", title: "Pots", bodyHtml: "<p>Pick a pot.</p>" }] },
    } as unknown as Partial<ContentPlan>);
    const [book] = contentPlanSources(ebook);
    expect(book).toMatchObject({ kind: "ebook", title: "The repotting book", format: "html", url: "/admin/workspace/ws_1/create/plan_1/ebook" });
    expect(book?.body).toContain("Pick a pot.");
  });
});

describe("the other kinds", () => {
  it("reads lifecycle emails, HTML or plain", () => {
    const j = { id: "lj_1", name: "Onboarding", draft: { pools: [{ id: "welcome", label: "Welcome", items: [{ id: "a", label: "A", subject: "Welcome", previewText: null, body: "<p>Hi</p>" }] }] } } as unknown as LifecycleJourney;
    expect(lifecycleSources(j)).toEqual([expect.objectContaining({ kind: "journey_email", ref: "lj_1/welcome/a", format: "html", url: "/admin/lifecycle/lj_1" })]);
  });

  it("reads a broadcast at its launch's page", () => {
    const b = { id: "b1", campaignId: "c1", name: "Launch day", subject: "We're live", body: "Plain text" } as never;
    expect(broadcastSource(b)).toMatchObject({ kind: "broadcast", title: "We're live", format: "plain", url: "/admin/launches/c1/broadcasts" });
  });

  it("takes only decided brand map records", () => {
    const rec = (status: string) => ({ id: "x", tenantId: "t", ref: "s1", name: "Repotting", status });
    expect(brandMapSource("subject", rec("decided"))?.title).toBe("Repotting");
    expect(brandMapSource("subject", rec("proposed"))).toBeNull();
  });

  it("leaves out notes that may name a customer, and keeps open questions as questions", () => {
    const n = (over: Partial<BrandNote>) => ({ id: "n1", text: "Customers repot in March.", kind: "observation", canName: false, status: "kept", ...over }) as BrandNote;
    expect(noteSource(n({}))?.kind).toBe("note");
    expect(noteSource(n({ canName: true }))).toBeNull();
    expect(noteSource(n({ status: "suggested" }))).toBeNull();
    expect(noteSource(n({ status: "asked", question: "When do people repot?" }))).toMatchObject({ kind: "question", ref: "note_n1", title: "When do people repot?" });
  });

  it("keeps what a competitor article covers but never its quotes or author", () => {
    const c = { id: "co1", name: "Leafy", analysis: { summary: "A plant shop blog." } } as unknown as Competitor;
    const a = { id: "a1", competitorId: "co1", title: "Repot guide", summary: "How to repot.", question: "When to repot?", angle: "Seasons", stats: [{ quote: "SECRET QUOTE" }], trust: { author: "Real Person" } } as unknown as CompetitorArticle;
    const out = competitorSources(c, [a]);
    expect(out.map((s) => s.ref)).toEqual(["co1", "co1/a1"]);
    const text = JSON.stringify(out);
    expect(text).not.toContain("SECRET QUOTE");
    expect(text).not.toContain("Real Person");
  });

  it("puts the brand voice, kit and author bios in one record, or none when empty", () => {
    expect(brandKitSource({}, [])).toBeNull();
    const src = brandKitSource({ brandVoice: { summary: "Warm and plain", dos: ["Say repot"] } } as never, [{ id: "au", name: "Sam Example", role: "Editor", bio: "Grows ferns." } as never]);
    expect(src?.body).toContain("Warm and plain");
    expect(src?.body).toContain("Sam Example, Editor");
  });
});

describe("stubOf", () => {
  it("changes version when the text changes", async () => {
    const a = stubOf({ kind: "idea", ref: "i1", title: "T", body: "one" });
    const b = stubOf({ kind: "idea", ref: "i1", title: "T", body: "two" });
    expect(a.version).not.toBe(b.version);
    expect(stubOf({ kind: "idea", ref: "i1", title: "T", body: "one" }).version).toBe(a.version);
    expect((await a.load())?.body).toBe("one");
  });
});

describe("brandMapStubs", () => {
  it("asks only for decided records, with the index every record kind has", async () => {
    const calls: Array<[string, unknown]> = [];
    const records = {
      pageAll: async (kind: string, opts?: unknown) => {
        calls.push([kind, opts]);
        return kind === "q" ? [{ id: "x", tenantId: "t", ref: "q1", text: "When do people repot?", status: "decided" }] : [];
      },
    };
    const stubs = await brandMapStubs(records as never, []);
    expect(calls.map(([k]) => k)).toEqual(["sub", "q", "sit"]);
    for (const [, opts] of calls) expect(opts).toEqual({ where: [["status", "==", "decided"]] });
    expect(stubs.map((s) => `${s.kind}:${s.ref}`)).toEqual(["question:q1"]);
  });
});

describe("signalSource", () => {
  const sig = {
    id: "sig_1",
    status: "ready",
    readyAt: "2026-11-18T12:00:00.000Z",
    about: { query: "How do I get cited by AI answers?", questionId: "q_1", subjectId: null },
    market: { country: "GB", language: "en" },
    results: {
      top: [{ position: 1, domain: "rival-a.test", url: "https://rival-a.test/x", title: "X" }],
      paa: [{ question: "How does ChatGPT choose sources?", url: null, domain: null }],
      alsoSearched: ["get cited step by step"],
      related: ["chatgpt sources"],
      aiOverview: { cites: [{ domain: "forum.test", url: "https://forum.test/t/1", title: "A thread" }] },
    },
  } as unknown as BrandSignal;

  it("keeps what Google showed for a question as research, with the market and date", () => {
    const src = signalSource(sig)!;
    expect(src).toMatchObject({ kind: "research", ref: "serp:sig_1", title: "Google: How do I get cited by AI answers?" });
    expect(src.body).toContain("Google United Kingdom, English, 2026-11-18");
    expect(src.body).toContain("- How does ChatGPT choose sources?");
    expect(src.body).toContain("Also searched: get cited step by step");
    expect(src.body).toContain("Related searches: chatgpt sources");
    expect(src.body).toContain("Google's AI Overview cites: A thread");
  });

  it("leaves out a lookup that isn't ready", () => {
    expect(signalSource({ ...sig, status: "posted", results: null })).toBeNull();
  });
});
