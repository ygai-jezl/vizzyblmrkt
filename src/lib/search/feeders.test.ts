import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrandNote } from "@/lib/types/brandNote";
import type { Competitor, CompetitorArticle } from "@/lib/types/competitor";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { LifecycleJourney } from "@/lib/types/lifecycle";
import type { BrandSignal } from "@/lib/types/brandSignal";
import { brandKitSource, brandMapSource, brandMapStubs, broadcastSource, competitorSources, contentPlanSources, ideaSource, learnedSource, lifecycleSources, noteSource, readBrandStubs, signalSource, stubOf } from "./feeders";
import type { LearnedEntry } from "@/lib/types/autopilot";
import type { IdeaItem } from "@/lib/types/ideaItem";
import { firstQuestions, isFamilyRecord, subjectSearchSource } from "./family";
import { chunkText, contentHash } from "./text";

// For readBrandStubs: the workspace content readers answer, every other read fails (no database).
const tenant = vi.hoisted(() => ({ forTenant: vi.fn() }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), forTenant: tenant.forTenant }));
const content = vi.hoisted(() => ({ listContentPlans: vi.fn(async () => []), listIdeaItems: vi.fn(async () => [] as unknown[]), listTemplates: vi.fn(async () => [] as unknown[]) }));
vi.mock("@/lib/tenant/workspaceContent", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/workspaceContent")>()), ...content }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => {
    throw new Error("no database in this test");
  },
}));

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
    const a = stubOf({ kind: "idea_board", ref: "i1", title: "T", body: "one" });
    const b = stubOf({ kind: "idea_board", ref: "i1", title: "T", body: "two" });
    expect(a.version).not.toBe(b.version);
    expect(stubOf({ kind: "idea_board", ref: "i1", title: "T", body: "one" }).version).toBe(a.version);
    expect((await a.load())?.body).toBe("one");
  });
});

const idea = { id: "i1", tenantId: "ten_fernleaf", workspaceId: "ws_1", title: "Repot in spring", note: "Our readers ask", text: "Saved from a forum.", url: "https://forum.example.com/t/1", status: "captured", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" } as IdeaItem;

describe("ideaSource", () => {
  it("reads an Idea Board item as an idea_board, at its board", () => {
    expect(ideaSource(idea)).toEqual({
      kind: "idea_board",
      ref: "i1",
      title: "Repot in spring",
      body: "Our readers ask\n\nSaved from a forum.\n\nLink: https://forum.example.com/t/1",
      url: "/admin/workspace/ws_1/curate/idea-board",
    });
  });
});

describe("readBrandStubs", () => {
  it("lists Idea Board items as idea_board stubs, and counts idea_board as read in full", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tenant.forTenant.mockReturnValue({ workspaces: { find: async () => [{ id: "ws_1" }] } });
    content.listIdeaItems.mockResolvedValue([idea]);
    content.listTemplates.mockResolvedValue([{ id: "t1", workspaceId: "ws_1", title: "Seasonal checklist", body: "Step one" }]);
    const { stubs, complete } = await readBrandStubs({ tenantId: "ten_fernleaf", region: "us", source: "system" });
    expect(stubs.map((st) => `${st.kind}:${st.ref}`)).toEqual(["idea_board:i1", "template:t1"]);
    expect(complete.has("idea_board")).toBe(true);
    expect(complete.has("template")).toBe(true);
    // A read that failed is not complete, so nothing of its kind is removed.
    expect(complete.has("broadcast")).toBe(false);
    expect((await stubs[0]!.load())?.kind).toBe("idea_board");
    warn.mockRestore();
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
    judged: {
      at: "2026-11-18T12:00:20.000Z",
      version: 1,
      items: [
        { text: "How does ChatGPT choose sources?", kind: "paa", verdict: "use", reason: "" },
        { text: "How do you seduce a Gemini?", kind: "paa", verdict: "drop", reason: "the star sign" },
        { text: "get cited step by step", kind: "also", verdict: "other", reason: "" },
      ],
    },
  } as unknown as BrandSignal;

  it("keeps what the judge found on the brand's topics as research, with the market and date", () => {
    const src = signalSource(sig)!;
    expect(src).toMatchObject({ kind: "research", ref: "serp:sig_1", title: "Google: How do I get cited by AI answers?" });
    expect(src.body).toContain("Google United Kingdom, English, 2026-11-18");
    expect(src.body).toContain("- How does ChatGPT choose sources?");
    expect(src.body).toContain("Also searched: get cited step by step");
    expect(src.body).not.toContain("seduce");
    expect(src.body).not.toContain("Related searches");
    expect(src.body).toContain("Google's AI Overview cites: A thread");
  });

  it("keeps only the question, market and cited pages until the judge has checked it", () => {
    const body = signalSource({ ...sig, judged: null })!.body;
    expect(body).not.toContain("How does ChatGPT choose sources?");
    expect(body).toContain("Google's AI Overview cites: A thread");
  });

  it("leaves out a lookup that isn't ready", () => {
    expect(signalSource({ ...sig, status: "posted", results: null })).toBeNull();
  });
});

describe("learnedSource", () => {
  it("keeps one thing learned as its own line, with its date", () => {
    const e = { id: "lrn_1", kind: "left_out", text: "How do you seduce a Gemini?", reason: "the star sign", from: "autopilot", at: "2026-11-18T12:00:00.000Z" } as LearnedEntry;
    expect(learnedSource(e)).toMatchObject({ kind: "learned", ref: "lrn_1", title: 'Left out as not for this brand: "How do you seduce a Gemini?", the star sign' });
    expect(learnedSource(e).body).toContain("2026-11-18");
  });
});

describe("the brand map family (ADR-0023)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const q = (ref: string, subjectId: string, text: string, over: Record<string, unknown> = {}) => ({ id: ref, tenantId: "t", ref, subjectId, text, status: "decided", order: 0, createdAt: "2026-11-01T00:00:00Z", ...over });

  it("reads subjects, questions and situations decided or proposed, each once, with their statuses", async () => {
    const calls: Array<[string, unknown]> = [];
    const rows: Record<string, unknown[]> = {
      sub: [
        { id: "s1", tenantId: "t", ref: "s1", name: "Repotting figs", status: "decided" },
        { id: "s2", tenantId: "t", ref: "s2", name: "Fig leaves dropping", status: "proposed" },
        { id: "s3", tenantId: "t", ref: "s3", name: "Old name", status: "decided", mergedInto: "s1" },
      ],
      q: [
        q("q1", "s1", "When do I repot a fig?"),
        q("q2", "s1", "Which pot for a fig?", { status: "proposed", order: 1 }),
        q("q3", "s2", "Why do fig leaves drop in winter?", { status: "proposed", from: "research" }),
        q("q4", "s2", "fig leaves dropping indoors", { status: "proposed", from: "search_console", fromConnectionId: "dcn_aaaaaaaaaaaaaaaaaaaa", order: 1 }),
      ],
      sit: [
        { id: "t1", tenantId: "t", ref: "t1", text: "My fig has outgrown its pot", status: "decided" },
        { id: "t2", tenantId: "t", ref: "t2", text: "Buying a fig as a gift", status: "proposed" },
      ],
    };
    const records = {
      pageAll: async (kind: string, opts?: unknown) => {
        calls.push([kind, opts]);
        return rows[kind] ?? [];
      },
    };
    const stubs = await brandMapStubs(records as never, [], { family: true });
    expect(calls).toEqual([
      ["sub", { where: [["status", "in", ["decided", "proposed"]]] }],
      ["q", { where: [["status", "in", ["decided", "proposed"]]] }],
      ["sit", { where: [["status", "in", ["decided", "proposed"]]] }],
    ]);
    // The merged away subject is left out; proposed questions are never records of their own.
    expect(stubs.map((st) => `${st.kind}:${st.ref}:${st.status ?? "none"}`)).toEqual([
      "subject:s1:decided",
      "subject:s2:proposed",
      "question:q1:none",
      "situation:t1:decided",
      "situation:t2:proposed",
    ]);
    // A decided subject is shown to people: its text carries its decided questions only.
    const s1 = await stubs[0]!.load();
    expect(s1?.body).toBe("Repotting figs\n\nWhen do I repot a fig?");
    // A proposed one carries its proposed questions, but never a search a connection proposed (ADR-0013).
    const s2 = await stubs[1]!.load();
    expect(s2?.body).toBe("Fig leaves dropping\n\nWhy do fig leaves drop in winter?");
  });

  it("never puts a search a connection proposed into a subject's text, until a person decides it", () => {
    const fromSearch = q("q5", "s1", "pet safe hanging plants", { status: "proposed", from: "search_console", fromConnectionId: "dcn_aaaaaaaaaaaaaaaaaaaa" });
    const research = q("q6", "s1", "Which pots suit a fig?", { status: "proposed", from: "research", order: 1 });
    const decided = q("q7", "s1", "When do I repot a fig?", { order: 2 });
    expect(firstQuestions([fromSearch, research, decided])).toEqual(["Which pots suit a fig?", "When do I repot a fig?"]);
    expect(firstQuestions([fromSearch, research, decided], { decidedOnly: true })).toEqual(["When do I repot a fig?"]);
    expect(firstQuestions([{ ...fromSearch, status: "decided" }])).toEqual(["pet safe hanging plants"]);
    expect(subjectSearchSource({ ref: "s1", name: "Pet safe plants", status: "proposed" }, [fromSearch])?.body).toBe("Pet safe plants");
  });

  it("makes a subject's text from its name, description and first 10 questions in their order, one chunk long", () => {
    const questions = [
      q("q3", "s1", "Third by order", { order: 2 }),
      q("q1", "s1", "First by order", { order: 0, createdAt: "2026-11-02T00:00:00Z" }),
      q("q0", "s1", "Same order, made earlier", { order: 0, createdAt: "2026-11-01T00:00:00Z" }),
      q("q9", "s1", "Dismissed", { status: "dismissed" }),
      ...Array.from({ length: 12 }, (_, i) => q(`qx${i}`, "s1", `Later question ${i} ${"about repotting a fig in spring ".repeat(4)}`, { order: 10 + i })),
    ];
    expect(firstQuestions(questions).slice(0, 3)).toEqual(["Same order, made earlier", "First by order", "Third by order"]);
    expect(firstQuestions(questions)).toHaveLength(10);
    const src = subjectSearchSource({ ref: "s1", name: "Repotting figs", description: "When and how to repot.", status: "decided" }, questions)!;
    expect(src).toMatchObject({ kind: "subject", ref: "s1", title: "Repotting figs", status: "decided" });
    expect(src.body.startsWith("Repotting figs\n\nWhen and how to repot.\n\nSame order, made earlier")).toBe(true);
    expect(chunkText(src.body)).toHaveLength(1);
    expect(subjectSearchSource({ ref: "s1", name: "Gone", status: "dismissed" }, [])).toBeNull();
  });

  it("tells the family from the brand map's own questions and competitors' summaries", () => {
    expect(isFamilyRecord("subject", "s1")).toBe(true);
    expect(isFamilyRecord("situation", "t1")).toBe(true);
    expect(isFamilyRecord("note", "bn_1")).toBe(true);
    expect(isFamilyRecord("question", "note_bn_1")).toBe(true);
    expect(isFamilyRecord("question", "q_1")).toBe(false);
    expect(isFamilyRecord("competitor", "cmp_1/art_1")).toBe(true);
    expect(isFamilyRecord("competitor", "cmp_1")).toBe(false);
    expect(isFamilyRecord("article", "plan_1")).toBe(false);
  });

  it("keeps a version with no status as it was, and moves it when a status changes", () => {
    const src = { kind: "note" as const, ref: "n1", title: "T", body: "B" };
    expect(stubOf(src).version).toBe(contentHash("note", "n1", "T", "B", undefined, undefined, undefined));
    expect(stubOf(src)).not.toHaveProperty("status");
    const kept = stubOf({ ...src, status: "kept" });
    expect(kept.status).toBe("kept");
    expect(kept.version).not.toBe(stubOf(src).version);
    expect(stubOf({ ...src, status: "asked" }).version).not.toBe(kept.version);
  });

  it("reads only the family for a brand without brand search, and leaves the family for its turn otherwise", async () => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "true");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const find = vi.fn(async () => [{ id: "ws_1" }]);
    tenant.forTenant.mockReturnValue({ workspaces: { find } });
    content.listIdeaItems.mockClear().mockResolvedValue([idea]);
    content.listTemplates.mockResolvedValue([]);
    const ctx = { tenantId: "ten_fernleaf", region: "us" as const, source: "system" as const };

    const familyOnly = await readBrandStubs(ctx, { familyOnly: true });
    expect(find).not.toHaveBeenCalled();
    expect(content.listIdeaItems).not.toHaveBeenCalled();
    // The family's reads fail here (no database), so nothing of theirs is complete either.
    expect(familyOnly).toEqual({ stubs: [], complete: new Set() });

    const between = await readBrandStubs(ctx, { familyNow: false });
    expect(between.stubs.map((st) => st.kind)).toEqual(["idea_board"]);
    for (const k of ["subject", "question", "situation", "note", "competitor"] as const) expect(between.complete.has(k)).toBe(false);
    expect(between.complete.has("idea_board")).toBe(true);

    const some = await readBrandStubs(ctx, { kinds: new Set(["template"]) });
    expect(some.stubs).toEqual([]);
    expect([...some.complete]).toEqual(["template"]);
    warn.mockRestore();
  });
});

