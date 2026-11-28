import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * generateTextWithImage with a deadline (learning loops step 4): the loops' lane profiles an image
 * with `timeoutMs`, so a slow call is given up and aborted instead of running past the tick it
 * shares. Without it the call is as it always was. The SDK is stubbed; the client memoizes at
 * module scope, so each case imports a fresh module.
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

describe("generateTextWithImage", () => {
  it("sends no abort signal without a timeout, as before", async () => {
    generateContent.mockResolvedValue({ text: '{"medium":"photograph"}' });
    const { generateTextWithImage, NO_USAGE } = await fresh();
    expect(await generateTextWithImage("profile it", "aGk=", "image/png", { usage: NO_USAGE })).toBe('{"medium":"photograph"}');
    expect(generateContent.mock.calls[0]![0].config).toBeUndefined();
  });

  it("gives up at timeoutMs, aborting the call, and returns null", async () => {
    let signal: AbortSignal | undefined;
    generateContent.mockImplementation((req: { config?: { abortSignal?: AbortSignal } }) => {
      signal = req.config?.abortSignal;
      return new Promise(() => {});
    });
    const { generateTextWithImage, NO_USAGE } = await fresh();
    const started = Date.now();
    expect(await generateTextWithImage("profile it", "aGk=", "image/png", { usage: NO_USAGE, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(signal?.aborted).toBe(true);
  });
});
