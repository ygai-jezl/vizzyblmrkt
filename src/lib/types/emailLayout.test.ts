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
