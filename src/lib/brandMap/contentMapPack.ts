import { packSiblings, type Circle } from "./packSiblings";

/**
 * The content map at any size, by levels (BRAND_MAP_SCALE_ENABLED): the brand's groups (or
 * buying situations), then one group's subjects, each a circle sized by how many questions it
 * holds. What is one level down (a group's subjects, a subject's questions) is drawn inside
 * as dots coloured by state, from the counts the circle already has — no extra reads — and
 * all of a level's dots are one path per state (a few thousand at most; past that each dot
 * stands for a share, in the same proportions). At most `maxCircles` circles can be clicked;
 * past that, the smallest are "+N more" (and the Subjects tab lists them all). Names show
 * where there is room. Pure and deterministic, so the map looks the same on every visit.
 */

export interface PackItem {
  id: string;
  label: string;
  /** How big its circle is: the questions it holds (at least 1). */
  value: number;
  proposed?: boolean;
  /** "4 of 11 answered". */
  score?: string;
  /** What is inside, one dot each, by state. */
  dots: { answered: number; drafted: number; open: number };
}

export interface PackCircle {
  id: string;
  label: string;
  x: number;
  y: number;
  r: number;
  proposed: boolean;
  score?: string;
  /** Big enough to read its name. */
  showLabel: boolean;
  /** Big enough to read its score too. */
  showScore: boolean;
}

export interface PackLevel {
  circles: PackCircle[];
  /** Items not drawn as circles (the smallest), shown as "+N more". */
  more: number;
  /** Every dot of the level, one SVG path per state. */
  dots: { answered: string; drafted: string; open: string };
  width: number;
  height: number;
}

export const MAX_CIRCLES = 400;
const LABEL_R = 34;
const SCORE_R = 46;
const PAD = 20;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** Dots in one circle, and in a whole level. Past these a dot stands for a share, not one each. */
const MAX_DOTS = 400;
const MAX_LEVEL_DOTS = 6000;
/** Smaller circles than this get no dots. */
const DOTS_R = 6;

type Dots = PackItem["dots"];

const round = (n: number) => Math.round(n * 10) / 10;
const dot = (x: number, y: number, r: number) =>
  `M${round(x - r)} ${round(y)}a${round(r)} ${round(r)} 0 1 0 ${round(2 * r)} 0a${round(r)} ${round(r)} 0 1 0 ${round(-2 * r)} 0`;
const dotTotal = (d: Dots) => d.answered + d.drafted + d.open;

/** `shown` dots split by state in the same proportions as `inner`. */
function shareOfDots(inner: Dots, shown: number): Dots {
  const total = dotTotal(inner);
  if (shown >= total) return inner;
  const answered = Math.round((inner.answered * shown) / total);
  const drafted = Math.min(shown - answered, Math.round((inner.drafted * shown) / total));
  return { answered, drafted, open: shown - answered - drafted };
}

/** One level of the map, laid out to fit `width` × `height`. */
export function packLevel(items: PackItem[], opts: { width: number; height: number; maxCircles?: number }): PackLevel {
  const max = opts.maxCircles ?? MAX_CIRCLES;
  const sorted = [...items].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const kept = sorted.slice(0, max);
  const dots = { answered: "", drafted: "", open: "" };
  if (!kept.length) return { circles: [], more: 0, dots, width: opts.width, height: opts.height };

  const placed: Array<Circle & { item: PackItem }> = kept.map((item) => ({ x: 0, y: 0, r: Math.sqrt(Math.max(1, item.value)), item }));
  // A little air between circles: pack them a touch bigger than they're drawn.
  const air = 1.06;
  const padded = placed.map((p) => ({ x: 0, y: 0, r: p.r * air }));
  const R = packSiblings(padded);
  const scale = (Math.min(opts.width, opts.height) / 2 - PAD) / Math.max(R, 1e-6);
  const cx = opts.width / 2;
  const cy = opts.height / 2;

  const circles: PackCircle[] = placed.map((p, i) => {
    const r = round(p.r * scale);
    return {
      id: p.item.id,
      label: p.item.label,
      x: round(cx + padded[i]!.x * scale),
      y: round(cy + padded[i]!.y * scale),
      r,
      proposed: Boolean(p.item.proposed),
      ...(p.item.score ? { score: p.item.score } : {}),
      showLabel: r >= LABEL_R,
      showScore: r >= SCORE_R,
    };
  });

  // Dots inside, in a sunflower: one each while the level has room, else a share by state.
  const wanted = circles.map((c, i) => (c.r > DOTS_R ? Math.min(MAX_DOTS, dotTotal(placed[i]!.item.dots)) : 0));
  const sum = wanted.reduce((a, b) => a + b, 0);
  const fit = sum > MAX_LEVEL_DOTS ? MAX_LEVEL_DOTS / sum : 1;
  circles.forEach((c, i) => {
    const shown = wanted[i]! > 0 ? Math.max(1, Math.floor(wanted[i]! * fit)) : 0;
    if (!shown) return;
    const inner = shareOfDots(placed[i]!.item.dots, shown);
    const area = c.r * 0.78;
    const dr = Math.max(0.8, Math.min(6, (area / Math.sqrt(shown)) * 0.45));
    for (let k = 0; k < shown; k += 1) {
      const rr = area * Math.sqrt((k + 0.5) / shown);
      const t = k * GOLDEN;
      const state = k < inner.answered ? "answered" : k < inner.answered + inner.drafted ? "drafted" : "open";
      dots[state] += dot(c.x + rr * Math.cos(t), c.y + rr * Math.sin(t), dr);
    }
  });
  return { circles, more: sorted.length - kept.length, dots, width: opts.width, height: opts.height };
}

/** A group (or the ungrouped) as a circle: its subjects inside, by how far along each is. */
export function groupItem(g: {
  id: string;
  name: string;
  totals: { subjects?: number; questions?: number; answered?: number; subjectsAnswered?: number; subjectsDrafted?: number; subjectsOpen?: number };
}): PackItem {
  const t = g.totals;
  return {
    id: g.id,
    label: g.name,
    value: Math.max(1, t.questions ?? 0, t.subjects ?? 0),
    score: `${t.answered ?? 0} of ${t.questions ?? 0} answered`,
    dots: { answered: t.subjectsAnswered ?? 0, drafted: t.subjectsDrafted ?? 0, open: t.subjectsOpen ?? 0 },
  };
}

/** A subject as a circle: its questions inside, by state. */
export function subjectItem(s: {
  id: string;
  name: string;
  status: string;
  counts: { questions: number; answered: number; drafted: number; planned: number; open: number };
}): PackItem {
  const c = s.counts;
  return {
    id: s.id,
    label: s.name,
    value: Math.max(1, c.questions),
    proposed: s.status === "proposed",
    score: `${c.answered} of ${c.questions} answered`,
    dots: { answered: c.answered, drafted: c.drafted + c.planned, open: c.open },
  };
}
