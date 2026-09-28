import { describe, it, expect } from "vitest";
import {
  cleanupFileName,
  fitWithin,
  hasWhiteBackground,
  makeWhite,
  removeWhiteBackground,
  showsAsWhiteBox,
  trimBox,
  type Cleaned,
} from "./logoCleanup";

type Rgba = [number, number, number, number];

const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];
const GREY: Rgba = [128, 128, 128, 255];
const PURPLE: Rgba = [0x7a, 0x3c, 0xff, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

/** A made-up image: `paint` gives each pixel's RGBA. */
function image(width: number, height: number, paint: (x: number, y: number) => Rgba) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(paint(x, y), (y * width + x) * 4);
  return { rgba, width, height };
}

function pixel(img: { rgba: ArrayLike<number>; width: number }, x: number, y: number): Rgba {
  const p = (y * img.width + x) * 4;
  return [img.rgba[p]!, img.rgba[p + 1]!, img.rgba[p + 2]!, img.rgba[p + 3]!];
}

function cleaned(r: Cleaned): Uint8ClampedArray {
  if (!r.changed) throw new Error(r.message);
  return r.rgba;
}

/**
 * 21×21, white, with a square black ring (3 to 6 from the centre) around a white hole, and a
 * grey anti-aliased rim (7 from the centre) outside it.
 */
const ring = image(21, 21, (x, y) => {
  const r = Math.max(Math.abs(x - 10), Math.abs(y - 10));
  return r <= 2 ? WHITE : r <= 6 ? BLACK : r === 7 ? GREY : WHITE;
});

/** 30×30, white, with a round black "o" (radius 5 to 9) and its white counter. */
const letterO = image(30, 30, (x, y) => {
  const r = Math.hypot(x - 15, y - 15);
  return r >= 5 && r < 9 ? BLACK : WHITE;
});

/** 12×8, white, with a solid #7a3cff mark from (3,2) to (8,5). */
const mark = image(12, 8, (x, y) => (x >= 3 && x <= 8 && y >= 2 && y <= 5 ? PURPLE : WHITE));

describe("removeWhiteBackground", () => {
  it("clears the background, keeps the ring and its enclosed white, and softens the rim back to its ink", () => {
    const out = { rgba: cleaned(removeWhiteBackground(ring.rgba, 21, 21)), width: 21 };
    expect(pixel(out, 0, 0)[3]).toBe(0);
    expect(pixel(out, 20, 20)[3]).toBe(0);
    expect(pixel(out, 10, 4)).toEqual(BLACK);
    expect(pixel(out, 10, 6)).toEqual(BLACK);
    // The hole: enclosed, so the fill never reached it.
    expect(pixel(out, 10, 10)).toEqual(WHITE);
    // The grey rim is half-covered black: half opaque, and black again (no white halo).
    const [r, g, b, a] = pixel(out, 10, 3);
    expect(a).toBeGreaterThanOrEqual(126);
    expect(a).toBeLessThanOrEqual(128);
    expect(Math.max(r, g, b)).toBeLessThanOrEqual(2);
  });

  it("keeps the inside of a letter white (the wordmark case)", () => {
    const out = { rgba: cleaned(removeWhiteBackground(letterO.rgba, 30, 30)), width: 30 };
    expect(pixel(out, 15, 15)).toEqual(WHITE);
    expect(pixel(out, 15, 8)).toEqual(BLACK);
    expect(pixel(out, 0, 0)[3]).toBe(0);
  });

  it("keeps a one-colour mark opaque in its own colour, edges included", () => {
    const out = { rgba: cleaned(removeWhiteBackground(mark.rgba, 12, 8)), width: 12 };
    expect(pixel(out, 3, 2)).toEqual(PURPLE);
    expect(pixel(out, 5, 3)).toEqual(PURPLE);
    expect(pixel(out, 0, 0)[3]).toBe(0);
  });

  it("finds nothing to remove when the edges aren't white", () => {
    const framed = image(10, 10, (x, y) => (x === 0 || y === 0 || x === 9 || y === 9 ? PURPLE : WHITE));
    expect(removeWhiteBackground(framed.rgba, 10, 10)).toEqual({
      changed: false,
      message: "No white background found around the edges",
    });
  });

  it("counts near-white JPEG noise as background", () => {
    const noisy = image(12, 8, (x, y) =>
      x >= 3 && x <= 8 && y >= 2 && y <= 5 ? BLACK : (x + y) % 2 ? [250, 252, 249, 255] : WHITE,
    );
    const out = { rgba: cleaned(removeWhiteBackground(noisy.rgba, 12, 8)), width: 12 };
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [11, 7],
      [10, 4],
    ] as const) {
      expect(pixel(out, x, y)[3]).toBe(0);
    }
    expect(pixel(out, 5, 3)).toEqual(BLACK);
  });
});

describe("makeWhite", () => {
  it("turns the ring white and opaque, clears its hole, and keeps the rim half opaque", () => {
    const out = { rgba: cleaned(makeWhite(ring.rgba, 21, 21)), width: 21 };
    expect(pixel(out, 10, 5)).toEqual(WHITE);
    expect(pixel(out, 10, 10)[3]).toBe(0);
    expect(pixel(out, 0, 0)[3]).toBe(0);
    const [r, g, b, a] = pixel(out, 10, 3);
    expect([r, g, b]).toEqual([255, 255, 255]);
    expect(a).toBeGreaterThanOrEqual(126);
    expect(a).toBeLessThanOrEqual(128);
  });

  it("clears the inside of a letter (the wordmark case)", () => {
    const out = { rgba: cleaned(makeWhite(letterO.rgba, 30, 30)), width: 30 };
    expect(pixel(out, 15, 15)[3]).toBe(0);
    expect(pixel(out, 15, 8)).toEqual(WHITE);
  });

  it("turns a one-colour mark of any colour solid white", () => {
    const out = { rgba: cleaned(makeWhite(mark.rgba, 12, 8)), width: 12 };
    expect(pixel(out, 3, 2)).toEqual(WHITE);
    expect(pixel(out, 8, 5)).toEqual(WHITE);
    expect(pixel(out, 0, 0)[3]).toBe(0);
  });

  it("clears near-white JPEG noise", () => {
    const noisy = image(4, 1, (x) => (x === 0 ? BLACK : [250, 252, 249, 255]));
    const out = { rgba: cleaned(makeWhite(noisy.rgba, 4, 1)), width: 4 };
    expect(pixel(out, 0, 0)).toEqual(WHITE);
    expect(pixel(out, 1, 0)[3]).toBe(0);
  });

  it("clears the noise around a light ink too, so the trim fits the mark", () => {
    // A #ffd400 mark from (15,6) to (24,13) on noisy white: scaled to so light an ink, the noise would stay as a haze.
    const noisy = image(40, 20, (x, y) =>
      x >= 15 && x <= 24 && y >= 6 && y <= 13 ? [0xff, 0xd4, 0x00, 255] : [250, 252, 249, 255],
    );
    const out = cleaned(makeWhite(noisy.rgba, 40, 20));
    expect(pixel({ rgba: out, width: 40 }, 0, 0)[3]).toBe(0);
    expect(pixel({ rgba: out, width: 40 }, 15, 6)).toEqual(WHITE);
    expect(trimBox(out, 40, 20)).toEqual({ x: 13, y: 4, width: 14, height: 12 });
  });

  it("can't whiten a logo with no ink", () => {
    const blank = image(4, 4, () => [240, 240, 240, 255]);
    expect(makeWhite(blank.rgba, 4, 4)).toEqual({ changed: false, message: "This logo is too light to turn white" });
  });
});

describe("trimBox", () => {
  it("fits what's left, with 2px of room", () => {
    const img = image(20, 10, (x, y) => (x >= 5 && x <= 7 && y >= 4 && y <= 5 ? BLACK : CLEAR));
    expect(trimBox(img.rgba, 20, 10)).toEqual({ x: 3, y: 2, width: 7, height: 6 });
  });

  it("stops the room at the image's edges and ignores near-transparent pixels", () => {
    const img = image(20, 10, (x, y) => (x === 0 && y === 0 ? BLACK : x === 19 ? [0, 0, 0, 7] : CLEAR));
    expect(trimBox(img.rgba, 20, 10)).toEqual({ x: 0, y: 0, width: 3, height: 3 });
  });

  it("has no box when nothing is left", () => {
    expect(trimBox(image(4, 4, () => CLEAR).rgba, 4, 4)).toBeNull();
  });
});

describe("fitWithin", () => {
  it("scales down to fit 600×144, keeping the shape", () => {
    expect(fitWithin(1200, 300)).toEqual({ width: 576, height: 144 });
    expect(fitWithin(2000, 100)).toEqual({ width: 600, height: 30 });
    expect(fitWithin(600, 144)).toEqual({ width: 600, height: 144 });
  });

  it("never scales up", () => {
    expect(fitWithin(300, 100)).toEqual({ width: 300, height: 100 });
  });
});

describe("hasWhiteBackground", () => {
  const withCorners = (corners: Rgba[]) =>
    image(8, 6, (x, y) => {
      const i = (y < 3 ? 0 : 2) + (x < 4 ? 0 : 1);
      return corners[i]!;
    });

  it("is white with 4 or 3 white corners", () => {
    expect(hasWhiteBackground(withCorners([WHITE, WHITE, WHITE, WHITE]).rgba, 8, 6)).toBe(true);
    expect(hasWhiteBackground(withCorners([WHITE, [240, 236, 250, 255], WHITE, PURPLE]).rgba, 8, 6)).toBe(true);
  });

  it("isn't with transparent or coloured corners", () => {
    expect(hasWhiteBackground(withCorners([CLEAR, CLEAR, CLEAR, CLEAR]).rgba, 8, 6)).toBe(false);
    expect(hasWhiteBackground(withCorners([WHITE, WHITE, PURPLE, PURPLE]).rgba, 8, 6)).toBe(false);
    expect(hasWhiteBackground(withCorners([WHITE, WHITE, [255, 255, 255, 200], BLACK]).rgba, 8, 6)).toBe(false);
    expect(hasWhiteBackground(withCorners([[234, 255, 255, 255], WHITE, WHITE, GREY]).rgba, 8, 6)).toBe(false);
  });

  it("copes with a 1px image", () => {
    expect(hasWhiteBackground(image(1, 1, () => WHITE).rgba, 1, 1)).toBe(true);
    expect(hasWhiteBackground([], 0, 0)).toBe(false);
  });
});

describe("showsAsWhiteBox", () => {
  it("a white box shows on a header unless every colour of it is near-white", () => {
    expect(showsAsWhiteBox(["#7c3aed"])).toBe(true);
    expect(showsAsWhiteBox(["#ffffff", "#7c3aed"])).toBe(true);
    expect(showsAsWhiteBox(["#ffffff"])).toBe(false);
    expect(showsAsWhiteBox(["#f0f0fa", "#ebebeb"])).toBe(false);
  });
});

describe("cleanupFileName", () => {
  it("names the new logo after the original, without its extension", () => {
    expect(cleanupFileName("Acme logo.png", "remove")).toBe("Acme logo (no background).png");
    expect(cleanupFileName("Acme logo.JPEG", "white")).toBe("Acme logo (white).png");
    expect(cleanupFileName("mark.webp", "white")).toBe("mark (white).png");
  });

  it("turns slashes into dashes, and falls back to Logo", () => {
    expect(cleanupFileName("brand/2026\\mark.jpg", "remove")).toBe("brand-2026-mark (no background).png");
    expect(cleanupFileName("  .png ", "white")).toBe("Logo (white).png");
  });

  it("fits 200 characters, never cutting a character in half", () => {
    const long = cleanupFileName(`${"a".repeat(300)}.png`, "remove");
    expect(long).toHaveLength(200);
    expect(long.endsWith("a (no background).png")).toBe(true);
    // The cut lands between the halves of the first emoji, so it goes whole.
    expect(cleanupFileName(`${"a".repeat(179)}😀😀.png`, "remove")).toBe(`${"a".repeat(179)} (no background).png`);
  });
});
