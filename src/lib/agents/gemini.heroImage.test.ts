import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The launch email hero (generateImage). Imagen and its generateImages call were shut down by
 * Google on 2026-08-17, so the hero is made by a Gemini image model through generateContent.
 * The SDK is stubbed; the client memoizes at module scope, so each case imports a fresh module.
 */
const generateContent = vi.fn();
const generateImages = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent, generateImages };
  },
  Modality: { TEXT: "TEXT", IMAGE: "IMAGE" },
}));

async function fresh() {
  vi.resetModules();
  return import("./gemini");
}

const PNG = Buffer.from("not-really-a-png").toString("base64");

beforeEach(() => {
  generateContent.mockReset();
  generateImages.mockReset();
  vi.stubEnv("GEMINI_API_KEY", "test-key-not-a-real-one");
  vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "false");
  vi.stubEnv("GEMINI_IMAGE_MODEL", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("generateImage", () => {
  it("makes one square image with Nano Banana 2.1 through generateContent, never Imagen", async () => {
    generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: "here it is" }, { inlineData: { data: PNG, mimeType: "image/png" } }] } }],
    });
    const { generateImage, NO_USAGE, isUsageLimited } = await fresh();
    const made = await generateImage("a calm launch hero", { usage: NO_USAGE });
    const img = isUsageLimited(made) ? null : made;

    expect(img?.mimeType).toBe("image/png");
    expect(img?.bytes.toString("base64")).toBe(PNG);
    expect(generateImages).not.toHaveBeenCalled();
    const req = generateContent.mock.calls[0]![0];
    expect(req.model).toBe("gemini-nano-banana-2.1");
    expect(req.contents).toBe("a calm launch hero");
    expect(req.config.responseModalities).toContain("IMAGE");
    expect(req.config.imageConfig).toEqual({ aspectRatio: "1:1" });
  });

  it("uses GEMINI_IMAGE_MODEL when it is set", async () => {
    vi.stubEnv("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image");
    generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { data: PNG, mimeType: "image/png" } }] } }],
    });
    const { generateImage, NO_USAGE } = await fresh();
    await generateImage("hero", { usage: NO_USAGE });
    expect(generateContent.mock.calls[0]![0].model).toBe("gemini-3.1-flash-image");
  });

  it("is null when the model sends no image, and null when the call fails", async () => {
    const { generateImage, NO_USAGE } = await fresh();
    generateContent.mockResolvedValueOnce({ candidates: [{ content: { parts: [{ text: "no image today" }] } }] });
    expect(await generateImage("hero", { usage: NO_USAGE })).toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    generateContent.mockRejectedValueOnce(new Error("model not found"));
    expect(await generateImage("hero", { usage: NO_USAGE })).toBeNull();
    warn.mockRestore();
  });
});
