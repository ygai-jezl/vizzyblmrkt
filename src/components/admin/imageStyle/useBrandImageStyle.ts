"use client";

import { useEffect, useState } from "react";
import type { StoredImageStyle } from "@/lib/types/imageStyle";

/** One read per page load, shared by every picker on the page. */
let pending: Promise<StoredImageStyle | null> | null = null;

function load(): Promise<StoredImageStyle | null> {
  pending ??= fetch("/api/admin/brand-kit/image-style")
    .then(async (res) => (res.ok ? (((await res.json()) as { imageStyle?: StoredImageStyle | null }).imageStyle ?? null) : null))
    .catch(() => null);
  return pending;
}

/**
 * The brand's image style, for the pickers to show "Brand default (…)". With `enabled` false
 * (the image style switched off) nothing is fetched.
 */
export function useBrandImageStyle(enabled = true): { style: StoredImageStyle | null; loaded: boolean } {
  const [state, setState] = useState<{ style: StoredImageStyle | null; loaded: boolean }>({ style: null, loaded: false });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void load().then((style) => {
      if (live) setState({ style, loaded: true });
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return state;
}
