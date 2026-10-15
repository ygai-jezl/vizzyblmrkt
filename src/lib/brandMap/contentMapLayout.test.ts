import { describe, expect, it } from "vitest";
import { BrandMapPageSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import { computeCoverage } from "@/lib/content/blog/coverage";
import { layoutContentMap, UNPLACED, type ContentMapInput, type MapPage } from "./contentMapLayout";

const qs = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `q_${prefix}${String(i).padStart(6, "0")}`, text: `${prefix} question ${i}?`, intent: "other" as const }));
const map = {
  subjects: [
    { id: "sub_aaaaaaaa", name: "Share of voice", home: "https://acme.example/share-of-voice", questions: qs("a", 4) },
    { id: "sub_bbbbbbbb", name: "Citations", questions: qs("b", 3) },
  ],
};
const row = (id: string, over: Partial<BrandMapPage>): BrandMapPage =>
  BrandMapPageSchema.parse({ id, tenantId: "ten_A", kind: "article", workspaceId: "ws1", planId: id, title: id, state: "live", ...over });
const asMap = (r: BrandMapPage): MapPage => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  url: r.url,
  state: r.state,
  subjectId: r.subjectId,
  primaryQuestion: r.primaryQuestion,
  names: r.names,
  links: r.links,
  linksKnown: r.linksKnown,
  workspaceId: r.workspaceId,
  planId: r.planId,
});

function input(rows: BrandMapPage[]): ContentMapInput {
  return {
    brand: { name: "Acme", statement: "" },
    coverage: computeCoverage(map, rows),
    pages: rows.map(asMap),
    homes: [{ url: "https://acme.example/share-of-voice", label: "Share of voice (a subject)" }],
  };
}

const A = row("p_a", { primaryRef: "q_a000000", url: "https://acme.example/blog/a", links: ["https://acme.example/blog/b", "https://acme.example/share-of-voice"] });
const B = row("p_b", { primaryRef: "q_a000001", url: "https://acme.example/blog/b", state: "draft" });
// A draft for Citations whose main question is one Share of voice has already: the same question twice.
const C = row("p_c", { subjectId: "sub_bbbbbbbb", url: "https://acme.example/blog/c", primaryRef: "q_a000001", state: "draft" });
const LOOSE = row("p_loose", { title: "An article on nothing on the map" });
const HOME = row("s_home", { kind: "site", workspaceId: null, planId: null, url: "https://acme.example/share-of-voice", title: "Share of voice", linksKnown: false });

describe("the content map's layout", () => {
  it("puts the brand in the centre, a subject's own page on the ring, and each subject as an area", () => {
    const { points } = layoutContentMap(input([A, B, C, LOOSE, HOME]));
    expect(points[0]).toMatchObject({ id: "brand", x: 0, y: 0 });
    expect(points.find((p) => p.ref === "s_home")).toMatchObject({ kind: "site", areaId: null });
    expect(points.filter((p) => p.kind === "area").map((p) => [p.title, p.score])).toEqual([
      ["Share of voice", "1/4"],
      ["Citations", "0/3"],
      ["Unplaced", undefined],
    ]);
    expect(points.find((p) => p.ref === "p_a")?.areaId).toBe("sub_aaaaaaaa");
    expect(points.find((p) => p.ref === "p_c")?.areaId).toBe("sub_bbbbbbbb");
    expect(points.find((p) => p.ref === "p_loose")?.areaId).toBe(UNPLACED);
    // Questions not written yet sit in their subject; answered ones are their article.
    expect(points.filter((p) => p.kind === "question" && p.areaId === "sub_aaaaaaaa")).toHaveLength(2);
  });

  it("looks the same every time", () => {
    expect(layoutContentMap(input([A, B, C, LOOSE, HOME]))).toEqual(layoutContentMap(input([A, B, C, LOOSE, HOME])));
  });

  it("never puts two points of a subject on top of each other, up to 30 of them", () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`p_${String(i).padStart(2, "0")}`, { subjectId: "sub_aaaaaaaa" }));
    const pts = layoutContentMap(input(many), { showOpen: false }).points.filter((p) => p.areaId === "sub_aaaaaaaa" && p.kind === "article");
    expect(pts).toHaveLength(30);
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) expect(Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y)).toBeGreaterThanOrEqual(14);
    }
    // And no two areas overlap.
    const areas = layoutContentMap(input([...many, C, LOOSE])).points.filter((p) => p.kind === "area");
    for (let i = 0; i < areas.length; i += 1) {
      for (let j = i + 1; j < areas.length; j += 1) {
        const [a, b] = [areas[i]!, areas[j]!];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.radius! + b.radius!);
      }
    }
  });

  it("shows at most so many points, and says how many more each subject has", () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`p_${String(i).padStart(2, "0")}`, { subjectId: "sub_aaaaaaaa" }));
    const { points } = layoutContentMap(input(many), { maxPoints: 30, showOpen: false });
    expect(points.filter((p) => p.kind === "article").length).toBeLessThanOrEqual(30);
    expect(points.find((p) => p.kind === "more")).toMatchObject({ areaId: "sub_aaaaaaaa", title: "+30 more", count: 30 });
  });

  it("shows one subject at a time, and leaves the questions not written yet out when asked", () => {
    const { points } = layoutContentMap(input([A, B, C, LOOSE, HOME]), { subjectId: "sub_bbbbbbbb", showOpen: false });
    expect(points.map((p) => p.ref).sort()).toEqual(["brand", "p_c", "sub_bbbbbbbb"]);
  });

  it("draws the links between pages on the map, the ones they should have, and the same question twice", () => {
    const later = row("p_d", { subjectId: "sub_aaaaaaaa", url: "https://acme.example/blog/d", liveAt: "2026-10-02T00:00:00.000Z" });
    const first = { ...A, liveAt: "2026-10-01T00:00:00.000Z" };
    const { lines } = layoutContentMap(input([first, B, C, HOME, later]));
    expect(lines.map((l) => `${l.kind} ${l.from}→${l.to}`).sort()).toEqual([
      "link page:p_a→page:p_b",
      "link page:p_a→page:s_home",
      "overlap page:p_b→page:p_c",
      "suggested page:p_a→page:p_d",
    ]);
    expect(layoutContentMap(input([first, B, C, HOME, later]), { showSuggested: false }).lines.some((l) => l.kind === "suggested")).toBe(false);
  });
});
