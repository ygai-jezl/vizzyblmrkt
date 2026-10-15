import { describe, expect, it } from "vitest";
import { BrandMapPageSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import { computeCoverage } from "@/lib/content/blog/coverage";
import { layoutContentMap, mapPageOf, UNPLACED, type ContentMapInput, type MapPoint } from "./contentMapLayout";
import { pageHref, pointDetails } from "./contentMapDetails";

const map = {
  subjects: [
    {
      id: "sub_aaaaaaaa",
      name: "Share of voice",
      home: "https://acme.example/share-of-voice",
      questions: [
        { id: "q_aaaaaaaa", text: "What is share of voice?", intent: "definition" as const },
        { id: "q_bbbbbbbb", text: "Which tools track share of voice in AI answers?", intent: "alternatives" as const },
      ],
    },
  ],
};
const row = (id: string, over: Partial<BrandMapPage>): BrandMapPage =>
  BrandMapPageSchema.parse({ id, tenantId: "ten_A", kind: "article", workspaceId: "ws1", planId: id.slice(2), title: id, state: "live", ...over });

const OLD = row("p_old", {
  title: "Share of voice, explained",
  primaryRef: "q_aaaaaaaa",
  primaryQuestion: "What is share of voice?",
  url: "https://acme.example/blog/sov",
  liveAt: "2026-09-01T00:00:00.000Z",
  names: ["Acme", "Rivalco"],
  links: ["https://acme.example/share-of-voice"],
});
const NEW = row("p_new", { title: "Share of voice, again", primaryRef: "q_aaaaaaaa", url: "https://acme.example/blog/sov-2", liveAt: "2026-10-01T00:00:00.000Z" });
const PLANNED = row("p_plan", { title: "AI tools that track share of voice", primaryQuestion: "What tools track AI share of voice?", state: "planned" });
const HOME = row("s_home", { kind: "site", workspaceId: null, planId: null, url: "https://acme.example/share-of-voice", title: "Share of voice", linksKnown: false });
const LOOSE = row("p_loose", { title: "Unrelated", state: "draft" });

const rows = [OLD, NEW, PLANNED, HOME, LOOSE];
const input: ContentMapInput = {
  brand: { name: "Acme", statement: "Acme measures how your brand shows up in AI answers." },
  coverage: computeCoverage(map, rows),
  pages: rows.map(mapPageOf),
  homes: [{ url: "https://acme.example/share-of-voice", label: "Share of voice (a subject)" }],
};
const points = layoutContentMap(input).points;
const at = (ref: string, kind?: MapPoint["kind"]) => points.find((p) => p.ref === ref && (!kind || p.kind === kind))!;

describe("what the content map says about a point", () => {
  it("the brand: who it is, and how far each subject is answered", () => {
    expect(pointDetails(at("brand"), input)).toMatchObject({
      kicker: "Your brand",
      title: "Acme",
      text: "Acme measures how your brand shows up in AI answers.",
      lists: [{ head: "Subjects", items: ["Share of voice · 1 of 2 answered"] }],
    });
  });

  it("a subject: its questions and their state, and a way to see it alone", () => {
    const d = pointDetails(at("sub_aaaaaaaa", "area"), input);
    expect(d).toMatchObject({ kicker: "Subject", title: "Share of voice", badge: "1 of 2 answered", actions: { showSubject: "sub_aaaaaaaa" } });
    expect(d.lists[0]!.items).toEqual(["Answered: What is share of voice?", "Open: Which tools track share of voice in AI answers?"]);
  });

  it("the unplaced area says why its pages are there", () => {
    expect(pointDetails(at(UNPLACED, "area"), input)).toMatchObject({ kicker: "Unplaced", title: "Pages on no subject", actions: {} });
  });

  it("a question not written yet: its subject, what probably answers it, and Write this next", () => {
    expect(pointDetails(at("q_bbbbbbbb"), input)).toEqual({
      kicker: "Question not written yet",
      title: "Which tools track share of voice in AI answers?",
      lists: [
        { head: "Subject", items: ["Share of voice"] },
        { head: "Probably answered by", items: ["AI tools that track share of voice"] },
      ],
      notes: [],
      actions: { writeNext: "q_bbbbbbbb" },
    });
  });

  it("an article: what it answers, its address and names, its links both ways, what it should link to, and its twin", () => {
    const d = pointDetails(at("p_old"), input);
    expect(d).toMatchObject({ kicker: "Live article", title: "Share of voice, explained", text: "What is share of voice?" });
    const list = (head: string) => d.lists.find((l) => l.head === head)?.items;
    expect(list("Answers")).toEqual(["What is share of voice?"]);
    expect(list("Address")).toEqual(["https://acme.example/blog/sov"]);
    expect(list("Names it uses")).toEqual(["Acme, Rivalco"]);
    expect(list("Links to")).toEqual(["Share of voice"]);
    expect(list("Linked from")).toEqual([]);
    expect(list("Should link to")).toEqual(["Share of voice, again"]);
    expect(d.notes).toEqual([{ tone: "warn", text: "Answers the same main question as “Share of voice, again”." }]);
    expect(d.actions).toEqual({ open: "/admin/workspace/ws1/create/old", view: "https://acme.example/blog/sov" });
    // A main question that is the title already is not said twice.
    expect(pointDetails(at("p_new"), { ...input, pages: input.pages.map((p) => (p.id === "p_new" ? { ...p, primaryQuestion: "Share of voice, again?" } : p)) }).text).toBeUndefined();
    // Not live: opened in the app, never as a page.
    expect(pointDetails(at("p_plan"), input).actions).toEqual({ open: "/admin/workspace/ws1/create/plan" });
  });

  it("a page on the site: what it is the home page for, who links to it, and that its own links are not read yet", () => {
    const d = pointDetails(at("s_home"), input);
    expect(d).toMatchObject({ kicker: "Page on your site", title: "Share of voice", actions: { view: "https://acme.example/share-of-voice" } });
    expect(d.lists.find((l) => l.head === "Home page for")?.items).toEqual(["Share of voice (a subject)"]);
    expect(d.lists.find((l) => l.head === "Linked from")?.items).toEqual(["Share of voice, explained"]);
    expect(d.lists.find((l) => l.head === "Links to")).toEqual({ head: "Links to", items: [] });
    expect(d.notes[0]).toMatchObject({ tone: "info" });
  });

  it("opens an article in the app and any other page at its address", () => {
    expect(pageHref({ kind: "article", workspaceId: "ws 1", planId: "p/1", url: null })).toBe("/admin/workspace/ws%201/create/p%2F1");
    expect(pageHref({ kind: "site", workspaceId: null, planId: null, url: "https://acme.example/x" })).toBe("https://acme.example/x");
    expect(pageHref({ kind: "site", workspaceId: null, planId: null, url: "javascript:alert(1)" })).toBeNull();
  });
});
