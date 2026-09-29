import { describe, it, expect } from "vitest";
import { ensureFooterLast, EmailLayoutSchema, type EmailLayout } from "./emailLayout";

const text = (id: string) => ({ id, kind: "text" as const, html: "<p>x</p>" });
const footer = (id: string) => ({ id, kind: "footer" as const, text: "" });

describe("ensureFooterLast", () => {
  it("appends a footer when none exists", () => {
    const out = ensureFooterLast({ blocks: [text("a"), text("b")] });
    expect(out.blocks).toHaveLength(3);
    expect(out.blocks.at(-1)?.kind).toBe("footer");
  });

  it("moves an existing footer to the end and keeps its sectionBg", () => {
    const layout: EmailLayout = {
      blocks: [
        { ...footer("f"), sectionBg: "#123456" },
        text("a"),
        text("b"),
      ],
    };
    const out = ensureFooterLast(layout);
    expect(out.blocks.map((b) => b.kind)).toEqual(["text", "text", "footer"]);
    const last = out.blocks.at(-1)!;
    expect(last.kind === "footer" && last.sectionBg).toBe("#123456");
  });

  it("collapses duplicate footers to exactly one (keeps the first)", () => {
    const out = ensureFooterLast({
      blocks: [text("a"), footer("f1"), footer("f2")],
    });
    expect(out.blocks.filter((b) => b.kind === "footer")).toHaveLength(1);
    expect(out.blocks.at(-1)?.id).toBe("f1");
  });

  it("produces a schema-valid layout", () => {
    const out = ensureFooterLast({ blocks: [text("a")] });
    expect(EmailLayoutSchema.safeParse(out).success).toBe(true);
  });
});

describe("a button's styleSource", () => {
  const button = (over: Record<string, unknown> = {}) => ({
    id: "b",
    kind: "button",
    label: "Go",
    href: "https://example.com/go",
    align: "center",
    bg: "#112233",
    color: "#ffffff",
    radius: 8,
    ...over,
  });
  const first = (over: Record<string, unknown> = {}) => EmailLayoutSchema.parse({ blocks: [button(over)] }).blocks[0]!;

  it("absent stays absent (the button follows the Email style), and the two known values round-trip", () => {
    expect("styleSource" in first()).toBe(false);
    expect(first({ styleSource: "own" })).toMatchObject({ styleSource: "own" });
    expect(first({ styleSource: "email_style" })).toMatchObject({ styleSource: "email_style" });
  });

  it("a value from a later build reads as absent and never fails the layout; the built colours are kept", () => {
    for (const styleSource of ["tinted", "OWN", 7, null, { mode: "own" }]) {
      const r = EmailLayoutSchema.safeParse({ blocks: [button({ styleSource }), { id: "t", kind: "text", html: "<p>x</p>" }] });
      expect(r.success).toBe(true);
      const b = r.data!.blocks[0]!;
      expect(b.kind).toBe("button");
      expect(b.kind === "button" ? b.styleSource : "not a button").toBeUndefined();
      expect(b).toMatchObject({ bg: "#112233", color: "#ffffff", radius: 8 });
      expect(r.data!.blocks).toHaveLength(2);
    }
  });
});
