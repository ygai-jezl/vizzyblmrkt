/**
 * Pre-Publishing Performance Score (PPS): a PURE, DETERMINISTIC 0–100 rating of a
 * draft's copy, computed BEFORE publish (no model call — so it scores live on every
 * keystroke and is re-checked at enqueue). Weighted over four heuristics:
 *   brevity · formatting · keyword · hook.
 * Channel-aware for brevity (an X post and a blog post have different "ideal" lengths).
 * Client-safe.
 */

export interface PpsBreakdown {
  brevity: number;
  formatting: number;
  keyword: number;
  hook: number;
  // Index signature so a breakdown is assignable to the persisted `Record<string, number>`
  // shape (ScheduledPost.pps.breakdown) — the four named dimensions above are the real keys.
  [dimension: string]: number;
}

export interface PpsResult {
  score: number; // 0–100
  breakdown: PpsBreakdown;
}

/** Weights sum to 1; the hook carries the most, per the PRD's emphasis. */
export const PPS_WEIGHTS = { brevity: 0.25, formatting: 0.25, keyword: 0.2, hook: 0.3 } as const;

/** Per-channel ideal/max body length (code points) for the brevity heuristic. */
const CHANNEL_LENGTH: Record<string, { ideal: number; max: number }> = {
  x: { ideal: 200, max: 280 },
  linkedin: { ideal: 1200, max: 3000 },
  instagram: { ideal: 300, max: 2200 },
  newsletter: { ideal: 900, max: 4000 },
  blog: { ideal: 1500, max: 20000 },
};
const DEFAULT_LENGTH = { ideal: 600, max: 4000 };

/** Hype/spam phrases that suppress organic reach. */
const SPAM_TERMS = [
  "buy now",
  "click here",
  "act now",
  "limited time",
  "guaranteed",
  "100% free",
  "free money",
  "make money fast",
  "risk-free",
  "no obligation",
  "order now",
  "cash bonus",
  "congratulations you",
  "don't miss out",
];

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const cp = (s: string): number => [...s].length;

export function scorePPS(text: string, channel = "standalone"): PpsResult {
  const t = text.trim();
  if (!t) return { score: 0, breakdown: { brevity: 0, formatting: 0, keyword: 0, hook: 0 } };
  const breakdown: PpsBreakdown = {
    brevity: scoreBrevity(t, channel),
    formatting: scoreFormatting(t),
    keyword: scoreKeyword(t),
    hook: scoreHook(t),
  };
  const score = clamp(
    breakdown.brevity * PPS_WEIGHTS.brevity +
      breakdown.formatting * PPS_WEIGHTS.formatting +
      breakdown.keyword * PPS_WEIGHTS.keyword +
      breakdown.hook * PPS_WEIGHTS.hook,
  );
  return { score, breakdown };
}

/** Rewards copy near the channel's ideal length; penalises walls of text. */
function scoreBrevity(t: string, channel: string): number {
  if (!t) return 0;
  const len = cp(t);
  const { ideal, max } = CHANNEL_LENGTH[channel] ?? DEFAULT_LENGTH;
  let base: number;
  if (len <= ideal) {
    // Short is fine but a near-empty draft isn't ideal: ramp 60→100 up to ideal.
    base = 60 + 40 * (len / ideal);
  } else if (len <= max) {
    base = 100 - 40 * ((len - ideal) / (max - ideal)); // 100→60 across the acceptable band
  } else {
    base = Math.max(0, 60 - 60 * Math.min(1, (len - max) / max)); // over max → toward 0
  }
  // Wall-of-text penalty: the longest paragraph over ~400 cp drags the score down.
  // reduce (not Math.max(...spread)) so a body with 100k+ paragraphs can't blow the
  // call-stack arg limit — scorePPS runs live on uncapped client-side editor text.
  const longest = t.split(/\n{2,}/).reduce((m, p) => Math.max(m, cp(p)), 0);
  const wall = longest > 400 ? Math.min(30, (longest - 400) / 40) : 0;
  return clamp(base - wall);
}

/** Rewards scannable structure (line breaks, multiple paragraphs, lists). */
function scoreFormatting(t: string): number {
  if (!t) return 0;
  let s = 50;
  const hasBreaks = t.includes("\n");
  const paras = t.split(/\n{2,}/).filter((p) => p.trim());
  const hasList = /^\s*([-*•]|\d+[.)])\s+/m.test(t);
  if (hasBreaks) s += 15;
  if (paras.length >= 2) s += 15;
  if (hasList) s += 15;
  if (!hasBreaks && cp(t) > 300) s -= 35; // one dense blob
  return clamp(s);
}

/** Penalises spam/hype phrasing, ALL-CAPS shouting, and exclamation spam. */
function scoreKeyword(t: string): number {
  if (!t) return 100;
  const lower = t.toLowerCase();
  const hits = SPAM_TERMS.reduce((n, term) => (lower.includes(term) ? n + 1 : n), 0);
  const capsWords = (t.match(/\b[A-Z]{4,}\b/g) ?? []).length;
  const bangs = (t.match(/!/g) ?? []).length;
  return clamp(
    100 - hits * 20 - Math.min(20, capsWords * 5) - Math.min(20, Math.max(0, bangs - 1) * 5),
  );
}

/** Rates the opening 1–2 sentences for curiosity / specificity / reader-focus. */
function scoreHook(t: string): number {
  if (!t) return 0;
  const hook = (t.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").trim() || t.slice(0, 160)).trim();
  let s = 40;
  if (/\?/.test(hook)) s += 15; // a question
  if (/\d/.test(hook)) s += 12; // a number / stat
  if (/\b(you|your)\b/i.test(hook)) s += 12; // reader-focused
  if (/\b(how|why|what|the secret|mistake|stop|never|nobody|most people)\b/i.test(hook)) s += 15;
  if (cp(hook) > 0 && cp(hook) <= 120) s += 6; // punchy
  if (/^(in this|today|i want to|i'm going to|welcome|hello|hi everyone|as a)\b/i.test(hook)) {
    s -= 20; // weak generic opener
  }
  return clamp(s);
}
