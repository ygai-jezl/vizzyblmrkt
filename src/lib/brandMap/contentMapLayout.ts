import type { Coverage } from "@/lib/content/blog/coverage";
import type { BrandMapPage, BrandMapPageState } from "@/lib/types/brandMapPage";
import type { BrandMapDecided } from "@/lib/types/brandMap";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { NAME_KIND_LABEL } from "./changes";

/**
 * Where everything sits on the content map (BRAND_MAP_PAGES_ENABLED): the brand in the
 * centre, the pages that are a subject's or a name's own page on a ring around it, and each
 * subject as an area further out with its articles, drafts and open questions inside. Pure
 * and deterministic, so the map looks the same on every visit, with no physics.
 * Client-safe.
 */

/** A page as the content map gets it: the row's facts, nothing stored about the brand. */
export interface MapPage {
  id: string;
  kind: "article" | "site";
  title: string;
  url: string | null;
  state: BrandMapPageState;
  subjectId: string | null;
  primaryQuestion: string;
  names: string[];
  links: string[];
  linksKnown: boolean;
  workspaceId: string | null;
  planId: string | null;
}

/** A row as the browser gets it: no fingerprint, no tenant. */
export function mapPageOf(r: BrandMapPage): MapPage {
  return {
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
  };
}

/** The pages that are something's own page on the saved map, and what for. */
export function homesOf(d: Pick<BrandMapDecided, "identity" | "subjects" | "names">): ContentMapInput["homes"] {
  return [
    ...(d.identity.site ? [{ url: d.identity.site, label: `${d.identity.name || "Your brand"}, the brand` }] : []),
    ...d.subjects.flatMap((s) => (s.home ? [{ url: s.home, label: `${s.name} (a subject)` }] : [])),
    ...d.names.flatMap((n) => (n.home ? [{ url: n.home, label: `${n.name} (${NAME_KIND_LABEL[n.kind]})` }] : [])),
  ];
}

export interface ContentMapInput {
  brand: { name: string; statement: string };
  coverage: Coverage;
  pages: MapPage[];
  /** The pages that are something's own page: the brand's site, a subject's, a name's. */
  homes: Array<{ url: string; label: string }>;
}

export interface LayoutOptions {
  /** Show one subject only. */
  subjectId?: string | null;
  /** Questions not written yet. */
  showOpen?: boolean;
  /** Links a page should have and does not. */
  showSuggested?: boolean;
  maxPoints?: number;
}

export type PointKind = "brand" | "area" | "article" | "question" | "site" | "more";
export type PointState = BrandMapPageState | "open";

export interface MapPoint {
  id: string;
  kind: PointKind;
  /** Its centre. */
  x: number;
  y: number;
  title: string;
  state: PointState | null;
  /** The area it sits in: a subject id, UNPLACED, or null (the brand and its ring). */
  areaId: string | null;
  /** What it is: a page id, a map question id, or a subject id. */
  ref: string;
  /** An area's size. */
  radius?: number;
  /** An area's "3/5"; a "+N more" count. */
  score?: string;
  count?: number;
}

export interface MapLine {
  id: string;
  from: string;
  to: string;
  kind: "link" | "suggested" | "overlap";
}

export interface ContentMapLayout {
  points: MapPoint[];
  lines: MapLine[];
}

export const UNPLACED = "unplaced";
export const MAX_POINTS = 300;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const SPACING = 22;

const ORDER: Record<PointState, number> = { live: 0, approved: 1, draft: 2, planned: 3, open: 4 };
const round = (n: number) => Math.round(n * 10) / 10;

interface Candidate {
  id: string;
  kind: "article" | "question" | "site";
  title: string;
  state: PointState;
  ref: string;
}

/** The points of one area, most finished first. */
function ordered(items: Candidate[]): Candidate[] {
  return [...items].sort(
    (a, b) => Number(a.kind === "site") - Number(b.kind === "site") || ORDER[a.state] - ORDER[b.state] || a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
  );
}

const areaRadius = (n: number) => Math.max(110, 40 + SPACING * Math.sqrt(Math.max(n, 1)));

/** How many of each group to show so that all of them together are at most `max`: a few each, then shares of the rest. */
function shares(sizes: number[], max: number): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= max) return sizes;
  const floor = Math.min(6, Math.floor(max / Math.max(1, sizes.filter((n) => n > 0).length)));
  const base = sizes.map((n) => Math.min(n, floor));
  const left = Math.max(0, max - base.reduce((a, b) => a + b, 0));
  const over = sizes.map((n, i) => n - base[i]!);
  const overTotal = over.reduce((a, b) => a + b, 0) || 1;
  return base.map((b, i) => b + Math.floor((left * over[i]!) / overTotal));
}

export function layoutContentMap(input: ContentMapInput, opts: LayoutOptions = {}): ContentMapLayout {
  const showOpen = opts.showOpen !== false;
  const max = opts.maxPoints ?? MAX_POINTS;
  const subjects = input.coverage.subjects.filter((s) => !opts.subjectId || s.id === opts.subjectId);

  // Which area a page sits in: its own subject, else the first subject it answers a question of.
  const answers = new Map<string, string>();
  for (const s of input.coverage.subjects) for (const q of s.questions) for (const p of q.pages) if (!answers.has(p.id)) answers.set(p.id, s.id);
  const homeUrls = new Set(input.homes.map((h) => normalizeUrl(h.url)).filter(Boolean));
  const ring: Candidate[] = [];
  const areas = new Map<string, Candidate[]>(subjects.map((s) => [s.id, []]));
  for (const p of input.pages) {
    const isHome = p.kind === "site" && p.url ? homeUrls.has(normalizeUrl(p.url)) : false;
    const area = (p.subjectId && input.coverage.subjects.some((s) => s.id === p.subjectId) ? p.subjectId : null) ?? answers.get(p.id) ?? null;
    const c: Candidate = { id: `page:${p.id}`, kind: p.kind, title: p.title || p.url || "Untitled", state: p.state, ref: p.id };
    if (opts.subjectId) {
      if (area === opts.subjectId) areas.get(area)!.push(c);
    } else if (isHome) ring.push(c);
    else if (area && areas.has(area)) areas.get(area)!.push(c);
    else areas.set(UNPLACED, [...(areas.get(UNPLACED) ?? []), c]);
  }
  if (showOpen) {
    for (const s of subjects) {
      for (const q of s.questions) if (q.state === "open") areas.get(s.id)!.push({ id: `q:${q.id}`, kind: "question", title: q.text, state: "open", ref: q.id });
    }
  }

  // At most `max` points in all: each area keeps a few, then its share of the rest; past
  // that, "+N more".
  const areaIds = [...areas.keys()].filter((id) => id !== UNPLACED || areas.get(id)!.length);
  const quota = shares([ring.length, ...areaIds.map((id) => areas.get(id)!.length)], max);

  const points: MapPoint[] = [{ id: "brand", kind: "brand", x: 0, y: 0, title: input.brand.name || "Your brand", state: null, areaId: null, ref: "brand" }];

  const ringKept = ordered(ring).slice(0, quota[0]);
  const r1 = ringKept.length ? 120 + 6 * ringKept.length : 0;
  ringKept.forEach((c, i) => {
    const a = -Math.PI / 2 + Math.PI / Math.max(ringKept.length, 1) + (2 * Math.PI * i) / ringKept.length;
    points.push({ ...c, x: round(r1 * Math.cos(a)), y: round(r1 * Math.sin(a)), areaId: null });
  });

  const kept = new Map(areaIds.map((id, i) => [id, ordered(areas.get(id)!).slice(0, quota[i + 1])]));
  const radii = new Map(areaIds.map((id) => [id, areaRadius(kept.get(id)!.length + (kept.get(id)!.length < areas.get(id)!.length ? 2 : 0))]));
  const biggest = Math.max(0, ...radii.values());
  const n = areaIds.length;
  const r2 = n <= 1 ? r1 + biggest + 90 : Math.max(r1 + biggest + 90, (biggest + 30) / Math.sin(Math.PI / n));

  areaIds.forEach((id, i) => {
    const angle = n <= 1 ? 0 : -Math.PI / 2 + Math.PI / n + (2 * Math.PI * i) / n;
    const cx = round(r2 * Math.cos(angle));
    const cy = round(r2 * Math.sin(angle));
    const radius = radii.get(id)!;
    const s = subjects.find((x) => x.id === id);
    points.push({
      id: `area:${id}`,
      kind: "area",
      x: cx,
      y: cy,
      title: s ? s.name : "Unplaced",
      state: null,
      areaId: id,
      ref: id,
      radius,
      ...(s ? { score: `${s.answered}/${s.questions.length}` } : {}),
    });
    kept.get(id)!.forEach((c, j) => {
      const r = 30 + SPACING * Math.sqrt(j);
      const t = j * GOLDEN;
      points.push({ ...c, x: round(cx + r * Math.cos(t)), y: round(cy + r * Math.sin(t)), areaId: id });
    });
    const hidden = areas.get(id)!.length - kept.get(id)!.length;
    if (hidden > 0) points.push({ id: `more:${id}`, kind: "more", x: cx, y: round(cy + radius - 16), title: `+${hidden} more`, state: null, areaId: id, ref: id, count: hidden });
  });

  // Lines between the pages on the map: their links, the links they should have, and two
  // pages with the same main question.
  const byUrl = new Map<string, string>();
  const shown = new Set(points.filter((p) => p.kind === "article" || p.kind === "site").map((p) => p.ref));
  for (const p of input.pages) if (shown.has(p.id) && p.url) byUrl.set(normalizeUrl(p.url), p.id);
  const lines: MapLine[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: MapLine["kind"]) => {
    if (from === to || !shown.has(from) || !shown.has(to)) return;
    const key = kind === "suggested" ? `${kind}:${from}>${to}` : `${kind}:${[from, to].sort().join("|")}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ id: key, from: `page:${from}`, to: `page:${to}`, kind });
  };
  for (const p of input.pages) {
    if (!shown.has(p.id)) continue;
    for (const l of p.links) {
      const to = byUrl.get(normalizeUrl(l));
      if (to) add(p.id, to, "link");
    }
  }
  if (opts.showSuggested !== false) for (const m of input.coverage.missingLinks) add(m.from.id, m.to.id, "suggested");
  for (const o of input.coverage.overlaps) for (let i = 1; i < o.pages.length; i += 1) add(o.pages[0]!.id, o.pages[i]!.id, "overlap");
  return { points, lines };
}
