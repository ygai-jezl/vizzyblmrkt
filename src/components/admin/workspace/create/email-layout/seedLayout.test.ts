import { describe, it, expect } from "vitest";
import { seedLayoutFromNode } from "./seedLayout";
import type { ContentNode } from "@/lib/types/contentPlan";

const LOGO = "https://cdn.example.com/api/brand-logo/ten_x/abc-123.png";

/** Minimal ContentNode — seedLayoutFromNode only reads `layout`, `subject`, `body`. */
function node(overrides: Partial<ContentNode> = {}): ContentNode {
  return { subject: "Hi", body: "<p>Body</p>", ...overrides } as ContentNode;
}

describe("seedLayoutFromNode — primary-logo default", () => {
  it("prepends a logo image block on a fresh seed when a primaryLogoUrl is given", () => {
    const layout = seedLayoutFromNode(node(), { primaryLogoUrl: LOGO });
    const first = layout.blocks[0]!;
    expect(first.kind).toBe("image");
    expect((first as { src: string }).src).toBe(LOGO);
    // The starter heading + copy block still follow, footer stays pinned last.
    expect(layout.blocks.some((b) => b.kind === "heading")).toBe(true);
    expect(layout.blocks.some((b) => b.role === "copy")).toBe(true);
    expect(layout.blocks[layout.blocks.length - 1]!.kind).toBe("footer");
  });

  it("adds NO logo block when there is no primary logo", () => {
    const layout = seedLayoutFromNode(node(), {});
    expect(layout.blocks.some((b) => b.kind === "image")).toBe(false);
    expect(layout.blocks[0]!.kind).toBe("heading");
  });

  it("never injects into — or clobbers — a SAVED layout, even with a primary logo", () => {
    const saved = node({
      layout: {
        blocks: [{ id: "keep_1", kind: "text", role: "copy", html: "<p>Mine</p>" }],
      },
    } as Partial<ContentNode>);
    const layout = seedLayoutFromNode(saved, { primaryLogoUrl: LOGO });
    // No logo image injected; the author's copy block survives untouched.
    expect(layout.blocks.some((b) => b.kind === "image")).toBe(false);
    const copy = layout.blocks.find((b) => b.role === "copy") as { html: string } | undefined;
    expect(copy?.html).toBe("<p>Mine</p>");
  });
});
