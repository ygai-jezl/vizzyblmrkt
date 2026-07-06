import { describe, it, expect } from "vitest";
import { ContentNodeSchema } from "./contentPlan";

const base = {
  id: "n1",
  type: "spoke" as const,
  channel: "linkedin",
  role: "LinkedIn Post",
  position: { x: 0, y: 0 },
};

describe("ContentNode social image fields", () => {
  it("parses a node WITHOUT the image fields (back-compat with old plans)", () => {
    const n = ContentNodeSchema.parse(base);
    expect(n.imageAssetRef ?? null).toBeNull();
    expect(n.imageAspect ?? null).toBeNull();
  });

  it("parses a node WITH the image fields", () => {
    const n = ContentNodeSchema.parse({
      ...base,
      imageAssetRef: "abc123.png",
      imageAspect: "4:5",
      imagePrompt: "a warm hero image",
    });
    expect(n.imageAssetRef).toBe("abc123.png");
    expect(n.imageAspect).toBe("4:5");
    expect(n.imagePrompt).toBe("a warm hero image");
  });

  it("rejects an aspect outside the operator-facing set", () => {
    expect(() => ContentNodeSchema.parse({ ...base, imageAspect: "2:1" })).toThrow();
  });
});
