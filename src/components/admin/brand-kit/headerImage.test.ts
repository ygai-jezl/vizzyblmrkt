import { describe, it, expect } from "vitest";
import {
  allOpaque,
  bannerAttempts,
  bannerFileName,
  bannerSize,
  bannerWarnings,
  climbBannerLadder,
  isBannerType,
  HEAVY_BANNER_BYTES,
  type BannerStep,
} from "./headerImage";

const MB = 1024 * 1024;

describe("isBannerType", () => {
  it("takes PNG and JPEG only", () => {
    expect(isBannerType("image/png")).toBe(true);
    expect(isBannerType("image/jpeg")).toBe(true);
    for (const t of ["image/webp", "image/svg+xml", "image/gif", "image/heic", "image/jpg", ""]) {
      expect(isBannerType(t)).toBe(false);
    }
  });
});

describe("bannerSize", () => {
  it("scales down to fit 1200 × 2400, keeping the shape", () => {
    expect(bannerSize(3000, 1000)).toEqual({ width: 1200, height: 400 });
    expect(bannerSize(800, 2500)).toEqual({ width: 768, height: 2400 });
    expect(bannerSize(3000, 9000)).toEqual({ width: 800, height: 2400 });
  });

  it("never scales up", () => {
    expect(bannerSize(800, 200)).toEqual({ width: 800, height: 200 });
  });

  it("fits a narrower width when asked", () => {
    expect(bannerSize(3000, 1000, 1000)).toEqual({ width: 1000, height: 333 });
  });

  it("an image with no size has none", () => {
    expect(bannerSize(0, 100)).toBeNull();
    expect(bannerSize(Number.NaN, 100)).toBeNull();
  });
});

describe("bannerAttempts", () => {
  const big = { width: 3000, height: 1000 };
  const small = { width: 800, height: 200 };

  it("a JPEG is always redrawn: 0.9, 0.8, 0.7, then 1000 wide at 0.8", () => {
    const { steps, refusal } = bannerAttempts({ type: "image/jpeg", opaque: true, ...small });
    expect(steps).toEqual([
      { maxWidth: 1200, mime: "image/jpeg", quality: 0.9 },
      { maxWidth: 1200, mime: "image/jpeg", quality: 0.8 },
      { maxWidth: 1200, mime: "image/jpeg", quality: 0.7 },
      { maxWidth: 1000, mime: "image/jpeg", quality: 0.8 },
    ]);
    expect(refusal).toMatch(/still over 1 MB after shrinking/);
  });

  it("a PNG that fits is tried as it is first; a bigger one is redrawn as a PNG", () => {
    expect(bannerAttempts({ type: "image/png", opaque: true, ...small }).steps[0]).toBe("original");
    expect(bannerAttempts({ type: "image/png", opaque: false, ...small }).steps[0]).toBe("original");
    expect(bannerAttempts({ type: "image/png", opaque: true, ...big }).steps[0]).toEqual({
      maxWidth: 1200,
      mime: "image/png",
    });
    // 1200 × 2400 exactly still fits; one pixel more doesn't.
    expect(bannerAttempts({ type: "image/png", opaque: true, width: 1200, height: 2400 }).steps[0]).toBe("original");
    expect(bannerAttempts({ type: "image/png", opaque: true, width: 1200, height: 2401 }).steps[0]).not.toBe("original");
  });

  it("an opaque PNG then turns into a JPEG: 0.85, 0.75, then 1000 wide at 0.8", () => {
    const { steps, refusal } = bannerAttempts({ type: "image/png", opaque: true, ...big });
    expect(steps).toEqual([
      { maxWidth: 1200, mime: "image/png" },
      { maxWidth: 1200, mime: "image/jpeg", quality: 0.85 },
      { maxWidth: 1200, mime: "image/jpeg", quality: 0.75 },
      { maxWidth: 1000, mime: "image/jpeg", quality: 0.8 },
    ]);
    expect(refusal).toMatch(/still over 1 MB after shrinking/);
  });

  it("a PNG with transparency stays a PNG, only narrower, with its own refusal", () => {
    const { steps, refusal } = bannerAttempts({ type: "image/png", opaque: false, ...big });
    expect(steps).toEqual([
      { maxWidth: 1200, mime: "image/png" },
      { maxWidth: 1000, mime: "image/png" },
    ]);
    expect(steps.some((s) => s !== "original" && s.mime === "image/jpeg")).toBe(false);
    expect(refusal).toBe("This PNG is over 1 MB even at 1000px wide — try a JPG, or a PNG with fewer colours");
  });
});

describe("climbBannerLadder", () => {
  const steps = bannerAttempts({ type: "image/jpeg", opaque: true, width: 4000, height: 3000 }).steps;
  /** An encoder that gives these sizes in turn, and records what it was asked for. */
  function encoder(sizes: Array<number | null>) {
    const asked: BannerStep[] = [];
    let i = 0;
    const encode = async (step: BannerStep) => {
      asked.push(step);
      const size = sizes[i++];
      return size === null || size === undefined ? null : { size };
    };
    return { encode, asked };
  }

  it("takes the first result at most 1 MB: a JPEG still over at 0.8 moves on to 0.7", async () => {
    const { encode, asked } = encoder([3 * MB, MB + 1, MB]);
    const out = await climbBannerLadder(steps, encode);
    expect(out).toEqual({ step: { maxWidth: 1200, mime: "image/jpeg", quality: 0.7 }, result: { size: MB } });
    expect(asked).toHaveLength(3);
  });

  it("never returns a result over the cap: none fits → too_big, after every step", async () => {
    const { encode, asked } = encoder([2 * MB, 2 * MB, 2 * MB, MB + 1]);
    expect(await climbBannerLadder(steps, encode)).toBe("too_big");
    expect(asked).toEqual(steps);
  });

  it("a step that can't be encoded stops the climb", async () => {
    const { encode, asked } = encoder([2 * MB, null]);
    expect(await climbBannerLadder(steps, encode)).toBe("unreadable");
    expect(asked).toHaveLength(2);
  });

  it("a small PNG goes as it is", async () => {
    const png = bannerAttempts({ type: "image/png", opaque: false, width: 800, height: 200 }).steps;
    const { encode } = encoder([200_000]);
    expect(await climbBannerLadder(png, encode)).toEqual({ step: "original", result: { size: 200_000 } });
  });
});

describe("allOpaque", () => {
  it("is true only when every pixel's alpha is 255", () => {
    expect(allOpaque([0, 0, 0, 255, 255, 255, 255, 255])).toBe(true);
    expect(allOpaque([0, 0, 0, 255, 255, 255, 255, 254])).toBe(false);
    expect(allOpaque([])).toBe(true);
  });
});

describe("bannerFileName", () => {
  it("gives what's sent its own extension", () => {
    expect(bannerFileName("Spring banner.png", "image/jpeg")).toBe("Spring banner.jpg");
    expect(bannerFileName("Spring banner.JPEG", "image/png")).toBe("Spring banner.png");
    expect(bannerFileName("Spring banner.jpg", "image/jpeg")).toBe("Spring banner.jpg");
    expect(bannerFileName("Spring banner", "image/jpeg")).toBe("Spring banner.jpg");
    // Only an image extension goes.
    expect(bannerFileName("v1.2 banner.png", "image/png")).toBe("v1.2 banner.png");
  });

  it("strips the path, and names a nameless file", () => {
    expect(bannerFileName("C:\\fakepath\\Spring banner.jpg", "image/jpeg")).toBe("Spring banner.jpg");
    expect(bannerFileName("photos/Spring banner.png", "image/png")).toBe("Spring banner.png");
    expect(bannerFileName(".png", "image/png")).toBe("Header image.png");
    expect(bannerFileName("", "image/jpeg")).toBe("Header image.jpg");
  });

  it("fits 200 characters, never cutting a character in half", () => {
    const long = bannerFileName(`${"a".repeat(300)}.png`, "image/jpeg");
    expect(long).toHaveLength(200);
    expect(long.endsWith(".jpg")).toBe(true);
    const emoji = bannerFileName(`${"a".repeat(195)}😀😀.png`, "image/png");
    expect(emoji.length).toBeLessThanOrEqual(200);
    expect(emoji).toBe(`${"a".repeat(195)}.png`);
  });
});

describe("bannerWarnings", () => {
  const fine = { width: 1200, height: 300, byteSize: 100_000 };

  it("a 1200px-wide, short, light banner has none", () => {
    expect(bannerWarnings(fine)).toEqual([]);
  });

  it("warns under 600px wide", () => {
    expect(bannerWarnings({ ...fine, width: 599, height: 100 })).toEqual([
      "This image is under 600px wide, so it may look blurry on large screens — 1200px wide is best",
    ]);
    expect(bannerWarnings({ ...fine, width: 600, height: 100 })).toEqual([]);
  });

  it("warns when taller than 400px at 600px wide", () => {
    expect(bannerWarnings({ ...fine, height: 800 })).toEqual([]);
    expect(bannerWarnings({ ...fine, height: 802 })).toEqual([
      "This image is tall for a header (401 px at 600px wide), so readers scroll before your message — under 400 is best",
    ]);
    // A tall portrait, shrunk to 2400 tall, warns rather than being refused.
    expect(bannerWarnings({ ...fine, width: 768, height: 2400 })[0]).toMatch(/tall for a header \(1875 px/);
  });

  it("warns over 300 KB; an unknown size doesn't", () => {
    expect(bannerWarnings({ ...fine, byteSize: HEAVY_BANNER_BYTES })).toEqual([]);
    expect(bannerWarnings({ ...fine, byteSize: HEAVY_BANNER_BYTES + 1 })).toEqual([
      "This image is over 300 KB, so it may load slowly on phones — a JPG at 1200px wide is usually smaller",
    ]);
    expect(bannerWarnings({ width: 1200, height: 300, byteSize: null })).toEqual([]);
    expect(bannerWarnings({ width: 1200, height: 300 })).toEqual([]);
  });
});
