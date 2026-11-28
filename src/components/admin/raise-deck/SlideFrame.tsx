"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { SLIDE_SIZE } from "@/lib/raise/docs/layouts";

/**
 * A 1280 by 720 slide scaled to its box with a CSS transform, so the slide is always drawn at its
 * real size and only shown smaller or larger. `SlideFrame` takes a fixed width (thumbnails, version
 * views) and has no hooks; `FitSlide` fills its parent, measured as it resizes (the studio, Present).
 */

/** The scale that fits a slide inside a box, keeping 16:9. */
export function fitScale(width: number, height?: number): number {
  const byWidth = width / SLIDE_SIZE.width;
  if (!height || height <= 0) return Math.max(0, byWidth);
  return Math.max(0, Math.min(byWidth, height / SLIDE_SIZE.height));
}

export function SlideFrame({ scale, children, className }: { scale: number; children: ReactNode; className?: string }) {
  return (
    <div className={className} style={{ width: SLIDE_SIZE.width * scale, height: SLIDE_SIZE.height * scale, overflow: "hidden", position: "relative", flex: "none" }}>
      <div style={{ width: SLIDE_SIZE.width, height: SLIDE_SIZE.height, transform: `scale(${scale})`, transformOrigin: "top left" }}>{children}</div>
    </div>
  );
}

/** A slide scaled to the width of its parent (and its height, with `fitHeight`). */
export function FitSlide({ children, fitHeight = false, className }: { children: ReactNode; fitHeight?: boolean; className?: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setScale(fitScale(el.clientWidth, fitHeight ? el.clientHeight : undefined));
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitHeight]);
  return (
    <div ref={box} className={className} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: fitHeight ? "100%" : undefined }}>
      <SlideFrame scale={scale}>{children}</SlideFrame>
    </div>
  );
}
