import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiUsage } from "./gemini";

/**
 * Structured output (generateJsonWithSchema, for Your next action): the schema goes to the API as
 * responseJsonSchema; a schema the API refuses as written (a 400) is asked again once in plain JSON
 * mode; any other failure is null, and every call is counted. The SDK is stubbed; the client
 * memoizes at module scope, so each case imports a fresh module.
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

function counting(): AiUsage & { tokens: number[]; lost: number } {
  const u = {
    tokens: [] as number[],
    lost: 0,
    check: async () => null,
    recordModel: async (n: number, _m: string, o?: { lost?: boolean }) => {
      if (o?.lost) u.lost += 1;
      else u.tokens.push(n);
    },
    recordSearches: async () => undefined,
    recordImages: async () => undefined,
  };
  return u;
}

const SCHEMA = { type: "object", properties: { steps: { type: "array", items: { type: "object", properties: { action: { type: "string", enum: ["a", "none"] } } } } } };

beforeEach(() => {
  generateContent.mockReset();
  vi.stubEnv("GEMINI_API_KEY", "test-key-not-a-real-one");
  vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("generateJsonWithSchema", () => {
  it("sends the schema as responseJsonSchema in JSON mode, and counts the tokens", async () => {
    generateContent.mockResolvedValue({ text: '{"steps":[]}', usageMetadata: { totalTokenCount: 321 } });
    const { generateJsonWithSchema } = await fresh();
    const usage = counting();
    expect(await generateJsonWithSchema("write", { schema: SCHEMA, timeoutMs: 1000, temperature: 0.3, thinkingBudget: 0, usage })).toBe('{"steps":[]}');
    const config = generateContent.mock.calls[0]![0].config;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseJsonSchema).toEqual(SCHEMA);
    expect(config.temperature).toBe(0.3);
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(usage.tokens).toEqual([321]);
  });

  it("asks once more in plain JSON mode when the schema is refused as written", async () => {
    generateContent.mockRejectedValueOnce(Object.assign(new Error("INVALID_ARGUMENT"), { status: 400 })).mockResolvedValueOnce({ text: '{"steps":[]}', usageMetadata: { totalTokenCount: 50 } });
    const { generateJsonWithSchema } = await fresh();
    const usage = counting();
    expect(await generateJsonWithSchema("write", { schema: SCHEMA, timeoutMs: 1000, usage })).toBe('{"steps":[]}');
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(generateContent.mock.calls[1]![0].config.responseJsonSchema).toBeUndefined();
    expect(generateContent.mock.calls[1]![0].config.responseMimeType).toBe("application/json");
    expect(usage.tokens).toEqual([50]);
  });

  it("is null on any other failure, counted as lost, with no second try", async () => {
    generateContent.mockRejectedValue(Object.assign(new Error("UNAVAILABLE"), { status: 503 }));
    const { generateJsonWithSchema } = await fresh();
    const usage = counting();
    expect(await generateJsonWithSchema("write", { schema: SCHEMA, timeoutMs: 1000, usage })).toBeNull();
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(usage.lost).toBe(1);
  });

  it("is null with no Gemini set up, and never calls", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { generateJsonWithSchema, NO_USAGE } = await fresh();
    expect(await generateJsonWithSchema("write", { schema: SCHEMA, timeoutMs: 1000, usage: NO_USAGE })).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });
});
