import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    const { generateGroundedText } = await fresh();
    const r = await generateGroundedText("find facts");
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
    const { generateGroundedText } = await fresh();
    expect(await generateGroundedText("find facts")).toMatchObject({ text: "FACT: something.", sources: [], supports: [] });
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    generateContent.mockRejectedValueOnce(new Error("quota"));
    expect(await generateGroundedText("find facts")).toBeNull();
    quiet.mockRestore();
  });

  it("takes a thinking budget, and asks again without it if the model refuses", async () => {
    generateContent.mockResolvedValue({ text: "Q: one?", candidates: [] });
    const { generateGroundedText } = await fresh();
    await generateGroundedText("find questions", { thinkingBudget: 1024 });
    expect(generateContent.mock.calls[0]![0].config).toMatchObject({ tools: [{ googleSearch: {} }], thinkingConfig: { thinkingBudget: 1024 } });

    generateContent.mockReset();
    generateContent.mockRejectedValueOnce(new Error("thinking_config unsupported")).mockResolvedValueOnce({ text: "Q: one?", candidates: [] });
    expect(await generateGroundedText("find questions", { thinkingBudget: 1024 })).toMatchObject({ text: "Q: one?" });
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(generateContent.mock.calls[1]![0].config).not.toHaveProperty("thinkingConfig");
  });

  it("is null when Gemini isn't configured", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { generateGroundedText } = await fresh();
    expect(await generateGroundedText("find facts")).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("a thinking budget", () => {
  it("is passed to the model, and only when asked for", async () => {
    generateContent.mockResolvedValue({ text: "ok" });
    const { generateText, generateTextWithDeadline } = await fresh();
    expect(await generateText("write")).toBe("ok");
    expect(generateContent.mock.calls[0]![0].config).toBeUndefined();
    expect(await generateText("write", { thinkingBudget: 2048 })).toBe("ok");
    expect(generateContent.mock.calls[1]![0].config).toEqual({ thinkingConfig: { thinkingBudget: 2048 } });
    expect(await generateTextWithDeadline("check", { timeoutMs: 5000, temperature: 0, thinkingBudget: 4096 })).toBe("ok");
    expect(generateContent.mock.calls[2]![0].config).toMatchObject({ temperature: 0, thinkingConfig: { thinkingBudget: 4096 } });
  });

  it("is dropped, and the call made again, when the model won't take it", async () => {
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    generateContent.mockRejectedValueOnce(new Error("thinking_config is not supported for this model")).mockResolvedValueOnce({ text: "ok" });
    const { generateText } = await fresh();
    expect(await generateText("write", { thinkingBudget: 2048 })).toBe("ok");
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(generateContent.mock.calls[1]![0].config).toBeUndefined();
    quiet.mockRestore();
  });
});
