import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fontInfo, missingCharacters } from "./sfntInfo";
import { woff2ToSfnt } from "./fonts";

// The OFL fonts we already ship for emails are the fixtures.
const font = (name: string) => readFileSync(join(process.cwd(), "public/email-fonts", name));

describe("sfntInfo", () => {
  it("reads family, weight and italic from a WOFF", () => {
    expect(fontInfo(font("inter-700.v1.woff"))).toEqual({ family: "Inter", weight: 700, italic: false });
    expect(fontInfo(font("lora-400.v1.woff"))).toMatchObject({ family: "Lora", weight: 400 });
  });

  it("reads a WOFF2 once it's unpacked to TTF, and the same facts come back", async () => {
    const woff2 = font("inter-700.v1.woff2");
    expect(fontInfo(woff2)).toBeNull();
    const ttf = await woff2ToSfnt(woff2);
    expect(ttf).not.toBeNull();
    expect(fontInfo(ttf!)).toEqual(fontInfo(font("inter-700.v1.woff")));
    // A file cut from a variable font keeps that font's name: we report what the file says.
    expect(fontInfo((await woff2ToSfnt(font("montserrat-700.v1.woff2")))!)).toEqual({
      family: "Montserrat Thin",
      weight: 700,
      italic: false,
    });
  });

  it("says which characters a font can't draw", async () => {
    const inter = font("inter-400.v1.woff");
    expect(missingCharacters(inter, "Your brand, in every answer: 42% more!")).toEqual([]);
    expect(missingCharacters(inter, "Hello 日本")).toEqual(["日", "本"]);
    const ttf = (await woff2ToSfnt(font("nunito-400.v1.woff2")))!;
    expect(missingCharacters(ttf, "Café")).toEqual([]);
  });

  it("gives null for anything that isn't a readable font", async () => {
    expect(fontInfo(Buffer.from("not a font at all, just some text"))).toBeNull();
    expect(missingCharacters(Buffer.alloc(8), "a")).toBeNull();
    const truncated = font("inter-400.v1.woff").subarray(0, 300);
    expect(fontInfo(truncated)).toBeNull();
    expect(await woff2ToSfnt(Buffer.from("wOF2 but nothing else"))).toBeNull();
    expect(await woff2ToSfnt(font("inter-400.v1.woff"))).toBeNull();
  });
});
