import { describe, it, expect, afterEach } from "vitest";
import { buildCarousel } from "./build";
import type { TenantContext } from "@/lib/tenant/types";
import { NO_USAGE, type GeneratedImage } from "@/lib/agents/gemini";
import type { StoreResult } from "@/lib/workspace/assetStore";

const ctx: TenantContext = { tenantId: "t", region: "us", source: "system" };
const img: GeneratedImage = { bytes: Buffer.from("png"), mimeType: "image/png" };

const okStore =
  (): Promise<StoreResult> => Promise.resolve({ ok: true, filename: "abc.png" });

function enable() {
  process.env.DISTRIBUTE_CAROUSEL_ENABLED = "true";
}
afterEach(() => {
  delete process.env.DISTRIBUTE_CAROUSEL_ENABLED;
});

describe("buildCarousel", () => {
  it("is disabled by default (flag off)", async () => {
    const r = await buildCarousel(ctx, "ws", "## A\nbody", {}, {
      generate: async () => img,
      store: okStore,
    });
    expect(r).toEqual({ ok: false, reason: "disabled" });
  });

  it("returns no_slides for empty body", async () => {
    enable();
    const r = await buildCarousel(ctx, "ws", "   ", {}, { generate: async () => img, store: okStore });
    expect(r).toEqual({ ok: false, reason: "no_slides" });
  });

  it("generates + stores one asset per slide", async () => {
    enable();
    let n = 0;
    const r = await buildCarousel(
      ctx,
      "ws",
      "## Hook\nGrab.\n\n## Point\nValue.",
      {},
      { generate: async () => img, store: async () => ({ ok: true, filename: `slide-${++n}.png` }) },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.slides.map((s) => s.index)).toEqual([1, 2]);
      expect(r.slides.map((s) => s.filename)).toEqual(["slide-1.png", "slide-2.png"]);
      expect(r.truncated).toBe(false);
    }
  });

  it("fails fast when image generation returns null", async () => {
    enable();
    const r = await buildCarousel(ctx, "ws", "## A\nbody", {}, {
      generate: async () => null,
      store: okStore,
    });
    expect(r).toEqual({ ok: false, reason: "generation_failed" });
  });

  it("fails when storage fails", async () => {
    enable();
    const r = await buildCarousel(ctx, "ws", "## A\nbody", {}, {
      generate: async () => img,
      store: async () => ({ ok: false, reason: "no_asset_bucket" }),
    });
    expect(r).toEqual({ ok: false, reason: "store_failed" });
  });

  it("stops at the first slide failure and issues no further calls", async () => {
    enable();
    let gen = 0;
    let store = 0;
    const r = await buildCarousel(
      ctx,
      "ws",
      "## A\na\n\n## B\nb\n\n## C\nc",
      {},
      {
        generate: async () => {
          gen += 1;
          return gen === 2 ? null : img; // slide 2 fails
        },
        store: async () => {
          store += 1;
          return { ok: true, filename: `s${store}.png` };
        },
      },
    );
    expect(r).toEqual({ ok: false, reason: "generation_failed" });
    expect(gen).toBe(2); // did NOT generate slide 3 after the slide-2 failure
    expect(store).toBe(1); // only slide 1 stored (the acknowledged orphan)
  });

  it("makes no slide when the whole carousel won't fit under the month's image cap", async () => {
    enable();
    const asked: number[] = [];
    let gen = 0;
    const usage = {
      ...NO_USAGE,
      check: async (_kind: "searches" | "images", units = 1) => {
        asked.push(units);
        return units > 2 ? { limited: true as const, used: 48, limit: 50 } : null;
      },
    };
    const r = await buildCarousel(ctx, "ws", "## A\na\n\n## B\nb\n\n## C\nc", {}, {
      usage,
      generate: async () => {
        gen += 1;
        return img;
      },
      store: okStore,
    });
    expect(r).toEqual({ ok: false, reason: "image_limit" });
    expect(asked).toEqual([3]);
    expect(gen).toBe(0);
  });

  it("propagates the truncation flag", async () => {
    enable();
    const body = Array.from({ length: 15 }, (_, i) => `## S${i}\nbody ${i}`).join("\n\n");
    const r = await buildCarousel(ctx, "ws", body, {}, { generate: async () => img, store: okStore });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.slides).toHaveLength(10);
      expect(r.truncated).toBe(true);
    }
  });
});
