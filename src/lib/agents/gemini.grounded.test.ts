import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroundedTextResult } from "./gemini";

/**
 * The two additions the blog hub leans on: a grounded call that returns WHAT grounded it
 * (the pages search returned, and which stretch of the answer each backs), and a cap on
 * thinking time that can never turn a working call into a failing one. The SDK is
 * stubbed; the client memoizes at module scope, so each case imports a fresh module.
 */
const generateContent = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
  Modality: { TEXT: "TEXT", IMAGE: "IMAGE" },
}));

async function fresh() {
  vi.resetModules();
  return import("./gemini");
}

beforeEach(() => {
  generateContent.mockReset();
  vi.stubEnv("GEMINI_API_KEY", "test-key-not-a-real-one");
  vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("generateGroundedText", () => {
  it("returns the answer with the pages search returned and what each one backs", async () => {
    generateContent.mockResolvedValue({
      text: "FACT: 51% of buyers start with an AI chatbot.",
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/a", title: "research.example.org", domain: "research.example.org" } },
              { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/b", title: "press.example.net" } },
            ],
            groundingSupports: [
              { segment: { text: "FACT: 51% of buyers start with an AI chatbot.", startIndex: 0, endIndex: 46 }, groundingChunkIndices: [0, 7, -1] },
            ],
          },
        },
      ],
    });
    const { generateGroundedText, NO_USAGE } = await fresh();
    const r = (await generateGroundedText("find facts", { usage: NO_USAGE })) as GroundedTextResult;
    expect(r?.text).toBe("FACT: 51% of buyers start with an AI chatbot.");
    expect(r?.sources).toEqual([
      { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/a", title: "research.example.org", domain: "research.example.org" },
      // No domain given: the title (which is the host) stands in.
      { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/b", title: "press.example.net", domain: "press.example.net" },
    ]);
    // An index that points at no source is dropped rather than trusted.
    expect(r?.supports).toEqual([{ text: "FACT: 51% of buyers start with an AI chatbot.", start: 0, end: 46, sourceIndexes: [0] }]);
    expect(generateContent.mock.calls[0]![0].config.tools).toEqual([{ googleSearch: {} }]);
  });

  it("answers without sources when search doesn't say what backed it, and null when the call fails", async () => {
    generateContent.mockResolvedValueOnce({ text: "FACT: something.", candidates: [{ groundingMetadata: { webSearchQueries: ["q"] } }] });
    const { generateGroundedText, NO_USAGE } = await fresh();
    expect(await generateGroundedText("find facts", { usage: NO_USAGE })).toMatchObject({ text: "FACT: something.", sources: [], supports: [], queries: ["q"] });
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    generateContent.mockRejectedValueOnce(new Error("quota"));
    expect(await generateGroundedText("find facts", { usage: NO_USAGE })).toBeNull();
    quiet.mockRestore();
  });

  it("takes a thinking budget, and asks again without it only when the model refuses the request", async () => {
    generateContent.mockResolvedValue({ text: "Q: one?", candidates: [] });
    const { generateGroundedText, NO_USAGE } = await fresh();
    await generateGroundedText("find questions", { thinkingBudget: 1024, usage: NO_USAGE });
    expect(generateContent.mock.calls[0]![0].config).toMatchObject({ tools: [{ googleSearch: {} }], thinkingConfig: { thinkingBudget: 1024 } });

    generateContent.mockReset();
    const refused = Object.assign(new Error("thinking_config unsupported"), { status: 400 });
    generateContent.mockRejectedValueOnce(refused).mockResolvedValueOnce({ text: "Q: one?", candidates: [] });
    expect(await generateGroundedText("find questions", { thinkingBudget: 1024, usage: NO_USAGE })).toMatchObject({ text: "Q: one?" });
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(generateContent.mock.calls[1]![0].config).not.toHaveProperty("thinkingConfig");

    // Any other failure may have searched already (and been billed): no second call.
    generateContent.mockReset();
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    generateContent.mockRejectedValueOnce(Object.assign(new Error("server error"), { status: 503 }));
    expect(await generateGroundedText("find questions", { thinkingBudget: 1024, usage: NO_USAGE })).toBeNull();
    expect(generateContent).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });

  it("is null when Gemini isn't configured", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { generateGroundedText, NO_USAGE } = await fresh();
    expect(await generateGroundedText("find facts", { usage: NO_USAGE })).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("metering web searches", () => {
  const meter = (limited: { limited: true; used: number; limit: number } | null = null) => ({
    check: vi.fn(async () => limited),
    recordModel: vi.fn(async () => undefined),
    recordSearches: vi.fn(async () => undefined),
    recordImages: vi.fn(async () => undefined),
  });

  it("counts the searches a call ran", async () => {
    generateContent.mockResolvedValue({ text: "ok", candidates: [{ groundingMetadata: { webSearchQueries: ["a", "b", "c"] } }] });
    const { generateGroundedText, generateGroundedJson } = await fresh();
    const m = meter();
    expect(await generateGroundedText("find", { usage: m })).toMatchObject({ queries: ["a", "b", "c"] });
    expect(m.recordSearches).toHaveBeenCalledWith(3, undefined);
    generateContent.mockResolvedValue({ text: '{"topics":[]}', candidates: [{ groundingMetadata: { webSearchQueries: ["x"] } }] });
    const j = meter();
    expect(await generateGroundedJson("trends", { usage: j })).toMatchObject({ json: { topics: [] }, queries: ["x"] });
    expect(j.recordSearches).toHaveBeenCalledWith(1, undefined);
  });

  it("makes no call at the brand's cap, and says so", async () => {
    const { generateGroundedText, generateGroundedJson, isSearchLimited } = await fresh();
    const m = meter({ limited: true, used: 300, limit: 300 });
    const r = await generateGroundedText("find", { usage: m });
    expect(isSearchLimited(r)).toBe(true);
    expect(await generateGroundedJson("trends", { usage: m })).toEqual({ limited: true, used: 300, limit: 300 });
    expect(generateContent).not.toHaveBeenCalled();
    expect(m.recordSearches).not.toHaveBeenCalled();
  });

  it("notes a call that failed after it may have searched", async () => {
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    generateContent.mockRejectedValue(new Error("deadline"));
    const { generateGroundedText, generateGroundedJson } = await fresh();
    const m = meter();
    expect(await generateGroundedText("find", { usage: m })).toBeNull();
    expect(m.recordSearches).toHaveBeenCalledWith(0, { lost: true });
    await generateGroundedJson("trends", { usage: m });
    expect(m.recordSearches).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });

  it("never fails a call because the meter couldn't write", async () => {
    generateContent.mockResolvedValue({ text: "ok", candidates: [{ groundingMetadata: { webSearchQueries: ["a"] } }] });
    const { generateGroundedText } = await fresh();
    const fail = async () => {
      throw new Error("write failed");
    };
    const m = { check: async () => null, recordModel: fail, recordSearches: fail, recordImages: fail };
    expect(await generateGroundedText("find", { usage: m })).toMatchObject({ text: "ok" });
  });
});

describe("a thinking budget", () => {
  it("is passed to the model, and only when asked for", async () => {
    generateContent.mockResolvedValue({ text: "ok" });
    const { generateText, generateTextWithDeadline, NO_USAGE } = await fresh();
    expect(await generateText("write", { usage: NO_USAGE })).toBe("ok");
    expect(generateContent.mock.calls[0]![0].config).toBeUndefined();
    expect(await generateText("write", { thinkingBudget: 2048, usage: NO_USAGE })).toBe("ok");
    expect(generateContent.mock.calls[1]![0].config).toEqual({ thinkingConfig: { thinkingBudget: 2048 } });
    expect(await generateTextWithDeadline("check", { timeoutMs: 5000, temperature: 0, thinkingBudget: 4096, usage: NO_USAGE })).toBe("ok");
    expect(generateContent.mock.calls[2]![0].config).toMatchObject({ temperature: 0, thinkingConfig: { thinkingBudget: 4096 } });
  });

  it("is dropped, and the call made again, when the model won't take it", async () => {
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    generateContent.mockRejectedValueOnce(new Error("thinking_config is not supported for this model")).mockResolvedValueOnce({ text: "ok" });
    const { generateText, NO_USAGE } = await fresh();
    expect(await generateText("write", { thinkingBudget: 2048, usage: NO_USAGE })).toBe("ok");
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(generateContent.mock.calls[1]![0].config).toBeUndefined();
    quiet.mockRestore();
  });
});
