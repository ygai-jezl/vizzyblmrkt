import { describe, expect, it } from "vitest";
import { accentFor, asTemplateImage } from "./styleImage";
import type { Tenant } from "@/lib/types/tenant";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe("styleImage helpers", () => {
  it("the accent: the image style's, else the palette's first, else ours", () => {
    expect(accentFor({ imageStyle: { defaultStyleId: null, accentHex: "#123456" } } as Tenant)).toBe("#123456");
    expect(accentFor({ brandKit: { palette: [{ hex: "red" }, { hex: "#ABCDEF" }] } } as Tenant)).toBe("#ABCDEF");
    expect(accentFor(null)).toBe("#5B4FE6");
  });

  it("only PNG and JPEG become template images, with their size", () => {
    expect(asTemplateImage(PNG)).toMatchObject({ width: 1, height: 1 });
    expect(asTemplateImage(PNG)!.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(asTemplateImage(Buffer.from("RIFF....WEBPVP8 "))).toBeNull();
  });
});
