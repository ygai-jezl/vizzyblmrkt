import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the model layer: the judge returns a score derived from which candidate's bytes it
// was given, so we can assert best-of-N picks the highest-scoring image deterministically.
vi.mock("@/lib/agents/gemini", () => ({
  generateTextWithImage: vi.fn(),
  NO_USAGE: {},
  isUsageLimited: (r: unknown) => typeof r === "object" && r !== null && (r as { limited?: unknown }).limited === true,
  parseFirstJson: (t: string) => {
    const m = t.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  },
}));

import { generateBestOfN, judgeBrandFit } from "./bestOfN";
import { generateTextWithImage, NO_USAGE } from "@/lib/agents/gemini";

const mockJudge = vi.mocked(generateTextWithImage);

const img = (tag: string) => ({ bytes: Buffer.from(tag), mimeType: "image/png" });
/** The picked image's tag, or null when none (or the image cap) came back. */
const tagOf = (r: Awaited<ReturnType<typeof generateBestOfN>>) => (r && "bytes" in r ? r.bytes.toString() : null);
const SCORES: Record<string, number> = { a: 10, b: 90, c: 50 };

beforeEach(() => {
  vi.clearAllMocks();
  // Score by the candidate's decoded bytes ("a"/"b"/"c").
  mockJudge.mockImplementation(async (_prompt, base64) => {
    const tag = Buffer.from(base64, "base64").toString();
    return JSON.stringify({ score: SCORES[tag] ?? 0 });
  });
});

describe("generateBestOfN", () => {
  it("returns the highest-scoring candidate", async () => {
    const queue = [img("a"), img("b"), img("c")];
    let i = 0;
    const best = await generateBestOfN({
      n: 3,
      generate: async () => queue[i++]!,
      styleReference: "brand style",
      brief: "hero",
      usage: NO_USAGE,
    });
    expect(tagOf(best)).toBe("b"); // 90 wins
  });

  it("skips a single generation (no judging) — degenerate N", async () => {
    const best = await generateBestOfN({
      n: 1,
      generate: async () => img("a"),
      styleReference: "s",
      brief: "b",
      usage: NO_USAGE,
    });
    expect(tagOf(best)).toBe("a");
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it("drops failed generations and returns null when none succeed", async () => {
    const best = await generateBestOfN({
      n: 2,
      generate: async () => null,
      styleReference: "s",
      brief: "b",
      usage: NO_USAGE,
    });
    expect(best).toBeNull();
  });

  it("drops candidates the image cap stopped, and says so when none were made", async () => {
    const limited = { limited: true as const, used: 50, limit: 50 };
    const queue = [limited, img("c")];
    let i = 0;
    const one = await generateBestOfN({ n: 2, generate: async () => queue[i++]!, styleReference: "s", brief: "b", usage: NO_USAGE });
    expect(tagOf(one)).toBe("c");
    expect(mockJudge).not.toHaveBeenCalled();
    const none = await generateBestOfN({ n: 2, generate: async () => limited, styleReference: "s", brief: "b", usage: NO_USAGE });
    expect(none).toEqual(limited);
  });

  it("falls back to the first candidate when every judge fails", async () => {
    mockJudge.mockResolvedValue(null); // judging unavailable
    const queue = [img("a"), img("b")];
    let i = 0;
    const best = await generateBestOfN({
      n: 2,
      generate: async () => queue[i++]!,
      styleReference: "s",
      brief: "b",
      usage: NO_USAGE,
    });
    expect(tagOf(best)).toBe("a"); // never worse than single-shot
  });
});

describe("judgeBrandFit", () => {
  it("clamps the score to 0–100", async () => {
    mockJudge.mockResolvedValue(JSON.stringify({ score: 150 }));
    expect(await judgeBrandFit({ candidate: img("x"), styleReference: "s", brief: "b", usage: NO_USAGE })).toBe(100);
  });

  it("returns null on a non-numeric / missing score", async () => {
    mockJudge.mockResolvedValue(JSON.stringify({ reasons: "meh" }));
    expect(await judgeBrandFit({ candidate: img("x"), styleReference: "s", brief: "b", usage: NO_USAGE })).toBeNull();
  });

  it("returns null when the model is unavailable", async () => {
    mockJudge.mockResolvedValue(null);
    expect(await judgeBrandFit({ candidate: img("x"), styleReference: "s", brief: "b", usage: NO_USAGE })).toBeNull();
  });
});
