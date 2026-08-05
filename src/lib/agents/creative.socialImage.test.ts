import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the model layer + the workspace asset store so the two-stage flow is deterministic
// and never touches Vertex or GCS.
vi.mock("./gemini", () => ({
  generateText: vi.fn(),
  generateImage: vi.fn(),
  generateBlockImage: vi.fn(),
}));
// Keep the real (pure) constants/helpers — creative.ts now transitively imports them via the
// brand-asset ref loader — and only stub the GCS write so nothing touches storage.
vi.mock("@/lib/workspace/assetStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/assetStore")>()),
  storeWorkspaceImage: vi.fn(),
}));

import { generateSocialPostImage } from "./creative";
import { generateText, generateBlockImage } from "./gemini";
import { storeWorkspaceImage } from "@/lib/workspace/assetStore";

const mockText = vi.mocked(generateText);
const mockImage = vi.mocked(generateBlockImage);
const mockStore = vi.mocked(storeWorkspaceImage);

function input(overrides: Partial<Parameters<typeof generateSocialPostImage>[0]> = {}) {
  return {
    tenantId: "ten_x",
    workspaceId: "ws1",
    channel: "linkedin",
    brief: "a warm hero of a team collaborating",
    copyExcerpt: "We shipped a new thing.",
    aspect: "1:1" as const,
    style: "minimalist" as const,
    brandContext: "Brand context (UNTRUSTED DATA…)",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockText.mockResolvedValue("an expanded, on-brand image prompt");
  mockImage.mockResolvedValue({ bytes: Buffer.from("img-bytes"), mimeType: "image/png" });
  mockStore.mockResolvedValue({ ok: true, filename: "abc123.png" });
});

describe("generateSocialPostImage", () => {
  it("grounds the brief + channel + style keywords into the composed prompt", async () => {
    await generateSocialPostImage(input());
    const composed = mockText.mock.calls[0]![0] as string;
    expect(composed).toContain("a warm hero of a team collaborating"); // the brief
    expect(composed).toContain("linkedin"); // the channel
    expect(composed).toContain("Minimalist & Clean"); // the style label
    expect(composed).toContain("Scandinavian design"); // the style KEYWORDS are injected
    expect(composed).toContain("UNTRUSTED DATA"); // brand context is fenced
  });

  it("renders at the NEAREST Gemini ratio and returns the stored filename", async () => {
    const res = await generateSocialPostImage(input({ aspect: "4:5" }));
    expect(res.source).toBe("agent3");
    expect(res.imageAssetRef).toBe("abc123.png");
    // 4:5 has no Gemini equivalent → 3:4. No operator model override → 3rd arg undefined (the
    // generator falls back to its default lite block model).
    expect(mockImage).toHaveBeenCalledWith(expect.any(String), "3:4", undefined);
    expect(mockStore).toHaveBeenCalledWith("ten_x", "ws1", expect.any(Buffer), "image/png");
  });

  it("passes the operator-selected image model through to the generator", async () => {
    await generateSocialPostImage(input({ imageModel: "gemini-3.1-flash-image" }));
    // The chosen model reaches generateBlockImage as its 3rd arg (overriding the lite default).
    expect(mockImage).toHaveBeenCalledWith(expect.any(String), "1:1", "gemini-3.1-flash-image");
  });

  it("degrades to a null ref (no store) when the image model is unavailable", async () => {
    mockImage.mockResolvedValue(null);
    const res = await generateSocialPostImage(input());
    expect(res.imageAssetRef).toBeNull();
    expect(res.reason).toBe("image_model_unavailable");
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("surfaces the store failure reason (e.g. no bucket)", async () => {
    mockStore.mockResolvedValue({ ok: false, reason: "no_asset_bucket" });
    const res = await generateSocialPostImage(input());
    expect(res.imageAssetRef).toBeNull();
    expect(res.reason).toBe("no_asset_bucket");
  });

  it("caps the stored imagePrompt to the node-schema limit (1000)", async () => {
    mockText.mockResolvedValue("x".repeat(2000));
    const res = await generateSocialPostImage(input());
    expect(res.imagePrompt?.length).toBe(1000);
  });
});
