import { generateTextWithImage, isUsageLimited, parseFirstJson } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import type { AiUsage, GeneratedImage, UsageLimited } from "@/lib/agents/gemini";

/**
 * Layer 3 of the brand-style feedback loop — the "reward model" step. Generate N
 * candidates and auto-pick the most on-brand, judged by a Gemini art-director against the
 * brand style reference (the assembled brand context, which already embeds the learned
 * style + any "avoid" clause). This is rejection sampling / RLAIF-lite: no training, just
 * generate-and-select. Expensive (N× generation + N× judging), so it's opt-in and gated.
 * Fail-soft throughout: if judging is unavailable it degrades to the first candidate.
 */

/** Judge one candidate's brand fit → 0–100, or null on failure. */
export async function judgeBrandFit(input: {
  candidate: GeneratedImage;
  /** Assembled brand context (palette/tone/learned style/avoid) — the on-brand reference. */
  styleReference: string;
  brief: string;
  /** The brand's usage: the judging call's tokens are counted. */
  usage: AiUsage;
}): Promise<number | null> {
  const raw = await generateTextWithImage(
    renderPrompt("content.brand_fit_judge", {
      style_reference: input.styleReference || "(no brand style on file)",
      brief: input.brief.slice(0, 800) || "(none)",
    }),
    input.candidate.bytes.toString("base64"),
    input.candidate.mimeType,
    { usage: input.usage },
  );
  if (!raw) return null;
  const json = parseFirstJson(raw) as { score?: unknown } | null;
  const score = typeof json?.score === "number" ? json.score : Number(json?.score);
  if (!Number.isFinite(score)) return null;
  return Math.min(Math.max(score, 0), 100);
}

/**
 * Produce N candidates via `generate`, judge each, and return the highest-scoring image.
 * - N is clamped to ≥1 by the caller (bestOfNCount()).
 * - Candidates that fail to generate are dropped; if none succeed, returns null.
 * - Candidates the image cap stopped are dropped too; if none succeed and one was stopped,
 *   returns that limit so the caller can say so.
 * - If every judge call fails, returns the first successful candidate (degrades to N=1)
 *   so best-of-N never does WORSE than a single generation.
 */
export async function generateBestOfN(input: {
  n: number;
  generate: () => Promise<GeneratedImage | UsageLimited | null>;
  styleReference: string;
  brief: string;
  /** The brand's usage: the judging calls' tokens are counted. */
  usage: AiUsage;
}): Promise<GeneratedImage | UsageLimited | null> {
  const n = Math.max(1, input.n);
  const made = await Promise.all(Array.from({ length: n }, () => input.generate()));
  const candidates = made.filter((c): c is GeneratedImage => c != null && !isUsageLimited(c));
  if (candidates.length === 0) return made.find(isUsageLimited) ?? null;
  if (candidates.length === 1) return candidates[0]!;

  const scored = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      score: await judgeBrandFit({
        candidate,
        styleReference: input.styleReference,
        brief: input.brief,
        usage: input.usage,
      }),
    })),
  );

  let best: GeneratedImage | null = null;
  let bestScore = -1;
  for (const s of scored) {
    if (s.score != null && s.score > bestScore) {
      bestScore = s.score;
      best = s.candidate;
    }
  }
  // All judges failed → fall back to the first candidate (never worse than single-shot).
  return best ?? candidates[0]!;
}
