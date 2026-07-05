import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/agents/gemini", () => ({
  generateText: vi.fn(),
  parseFirstJson: (text: string): unknown | null => {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s < 0 || e <= s) return null;
    try {
      return JSON.parse(text.slice(s, e + 1));
    } catch {
      return null;
    }
  },
}));

import { generateEmailLayout } from "./generateEmailLayout";
import { generateText } from "@/lib/agents/gemini";

const mocked = vi.mocked(generateText);

const base = { brief: "welcome email", subject: "Welcome", currentBody: "<p>Hi there</p>" };

describe("generateEmailLayout", () => {
  beforeEach(() => mocked.mockReset());

  it("normalizes a generated layout: fresh ids, one copy block seeded with existing body", async () => {
    mocked.mockResolvedValue(
      JSON.stringify({
        blocks: [
          { id: "h", kind: "heading", html: "Welcome", level: 2, align: "left" },
          { id: "t", kind: "text", role: "copy", html: "" },
          { id: "b", kind: "button", label: "Go", href: "", align: "center", bg: "#111111", color: "#ffffff", radius: 8 },
          { id: "f", kind: "footer", text: "bye" },
        ],
      }),
    );
    const layout = await generateEmailLayout(base);
    expect(layout).toBeTruthy();
    const blocks = layout!.blocks;
    // exactly one copy block, seeded with the existing body
    const copies = blocks.filter((b) => b.role === "copy");
    expect(copies).toHaveLength(1);
    expect(JSON.stringify(copies[0])).toContain("Hi there");
    // fresh ids (not the model's "h"/"t"/"b")
    expect(blocks.every((b) => b.id.includes("_"))).toBe(true);
    expect(blocks.some((b) => b.kind === "footer")).toBe(true);
  });

  it("collapses multiple copy roles to exactly one", async () => {
    mocked.mockResolvedValue(
      JSON.stringify({
        blocks: [
          { id: "t1", kind: "text", role: "copy", html: "a" },
          { id: "t2", kind: "text", role: "copy", html: "b" },
        ],
      }),
    );
    const layout = await generateEmailLayout(base);
    expect(layout!.blocks.filter((b) => b.role === "copy")).toHaveLength(1);
  });

  it("synthesizes a copy block when the model emits none", async () => {
    mocked.mockResolvedValue(
      JSON.stringify({ blocks: [{ id: "img", kind: "image", src: "", alt: "", width: 560, align: "center" }] }),
    );
    const layout = await generateEmailLayout(base);
    const copies = layout!.blocks.filter((b) => b.role === "copy");
    expect(copies).toHaveLength(1);
    expect(copies[0]!.kind).toBe("text");
  });

  it("clamps an oversized copy body to the text-block cap (stays schema-valid)", async () => {
    mocked.mockResolvedValue(JSON.stringify({ blocks: [{ id: "t", kind: "text", role: "copy", html: "" }] }));
    const bigBody = `<p>${"x".repeat(20000)}</p>`;
    const layout = await generateEmailLayout({ ...base, currentBody: bigBody });
    expect(layout).toBeTruthy();
    const copy = layout!.blocks.find((b) => b.role === "copy") as { html: string };
    expect(copy.html.length).toBeLessThanOrEqual(8000);
  });

  it("returns null on unparseable / empty output", async () => {
    mocked.mockResolvedValue("sorry, no JSON here");
    expect(await generateEmailLayout(base)).toBeNull();
    mocked.mockResolvedValue(JSON.stringify({ blocks: [] }));
    expect(await generateEmailLayout(base)).toBeNull();
  });
});
