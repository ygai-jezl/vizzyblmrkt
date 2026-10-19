import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheKey, clearGoogleFontMemory, googleFontTtf, gstaticUrl, type GoogleFontDeps } from "./googleFonts";

const TTF_URL = "https://fonts.gstatic.com/s/worksans/v19/abc.ttf";
const css = (url: string) => `@font-face { font-family: 'Work Sans'; src: url(${url}) format('truetype'); }`;
// Any real font file will do for "reads as a font".
const FONT = readFileSync(join(process.cwd(), "public/email-fonts/inter-700.v1.woff"));

function deps(over: Partial<GoogleFontDeps> = {}) {
  const d = {
    fetchCss: vi.fn(async (_u: string) => ({ status: 200, text: css(TTF_URL) }) as { status: number; text: string } | null),
    fetchFont: vi.fn(async (_u: string) => FONT as Buffer | null),
    readCache: vi.fn(async (_k: string) => null as Buffer | null),
    writeCache: vi.fn(async (_k: string, _b: Buffer) => {}),
  };
  Object.assign(d, over);
  return d;
}

beforeEach(() => clearGoogleFontMemory());

describe("googleFontTtf", () => {
  it("fetches the family's TTF once, caching it in the bucket and in memory", async () => {
    const d = deps();
    expect(await googleFontTtf("Work Sans", 700, d)).toBe(FONT);
    expect(d.fetchCss.mock.calls[0]![0]).toBe("https://fonts.googleapis.com/css2?family=Work+Sans:wght@700");
    expect(d.fetchFont).toHaveBeenCalledWith(TTF_URL);
    expect(d.writeCache).toHaveBeenCalledWith("work-sans-700.ttf", FONT);
    await googleFontTtf("Work Sans", 700, d);
    expect(d.fetchCss).toHaveBeenCalledTimes(1);
  });

  it("uses the bucket copy when there is one", async () => {
    const d = deps({ readCache: vi.fn(async () => FONT) });
    expect(await googleFontTtf("Lora", 400, d)).toBe(FONT);
    expect(d.fetchCss).not.toHaveBeenCalled();
  });

  it("asks for the default weight when the family hasn't the one asked for", async () => {
    const d = deps();
    d.fetchCss.mockResolvedValueOnce({ status: 400, text: "" });
    expect(await googleFontTtf("Anton", 700, d)).toBe(FONT);
    expect(d.fetchCss.mock.calls[1]![0]).toBe("https://fonts.googleapis.com/css2?family=Anton");
  });

  it("only takes fonts.gstatic.com, only real fonts, and retries after a network failure", async () => {
    expect(gstaticUrl(css("https://evil.example.com/x.ttf"))).toBeNull();
    expect(gstaticUrl(css("http://fonts.gstatic.com/x.ttf"))).toBeNull();
    const notFont = deps({ fetchFont: vi.fn(async () => Buffer.from("<html>")) });
    expect(await googleFontTtf("Work Sans", 400, notFont)).toBeNull();
    const down = deps({ fetchCss: vi.fn(async () => null) });
    expect(await googleFontTtf("Karla", 400, down)).toBeNull();
    const up = deps();
    expect(await googleFontTtf("Karla", 400, up)).toBe(FONT);
  });

  it("cache keys are slugs", () => {
    expect(cacheKey("Source Serif 4", 700)).toBe("source-serif-4-700.ttf");
  });
});
