import type { ReactElement } from "react";
import { ImageResponse } from "next/og";

/**
 * Render a template to a PNG with next/og (Satori), in process. Never fetches anything: images
 * come in as data URIs and fonts as bytes. At most two renders run at once per instance, each
 * with a 10 s limit, so a burst can't exhaust memory.
 */

export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

export interface RenderFont {
  name: string;
  data: Buffer;
  weight: FontWeight;
  style: "normal" | "italic";
}

export const RENDER_SIZES = {
  hero: { width: 1600, height: 900 },
  share: { width: 1200, height: 630 },
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  landscape: { width: 1200, height: 628 },
} as const;
export type RenderSize = keyof typeof RENDER_SIZES;

const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 10_000;

let running = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

/** Nearest weight Satori accepts. */
export function toFontWeight(w: number | undefined): FontWeight {
  const n = Math.min(900, Math.max(100, Math.round((w ?? 400) / 100) * 100));
  return n as FontWeight;
}

/** PNG bytes, or null when the render failed or ran out of time. */
export async function renderPng(
  element: ReactElement,
  opts: { width: number; height: number; fonts: RenderFont[] },
): Promise<Buffer | null> {
  await acquire();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const render = (async () => {
      const res = new ImageResponse(element, {
        width: opts.width,
        height: opts.height,
        fonts: opts.fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: f.style })),
      });
      return Buffer.from(await res.arrayBuffer());
    })();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    });
    const png = await Promise.race([render, timeout]);
    // A PNG starts with \x89PNG; anything else (an empty body on a Satori error) is a failure.
    return png && png.length > 8 && png.toString("latin1", 1, 4) === "PNG" ? png : null;
  } catch (err) {
    console.warn("[imageStyle] render failed:", err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
}
