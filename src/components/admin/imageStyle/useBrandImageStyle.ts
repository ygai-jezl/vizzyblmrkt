"use client";

import { useEffect, useState } from "react";
import type { StoredImageStyle } from "@/lib/types/imageStyle";

interface Loaded {
  style: StoredImageStyle | null;
  /** Image style versions are on (IMAGE_STYLE_VERSIONS_ENABLED): the server says so. */
  versions: boolean;
}

/** One read per page load, shared by every picker on the page. */
let pending: Promise<Loaded> | null = null;

function load(): Promise<Loaded> {
  pending ??= fetch("/api/admin/brand-kit/image-style")
    .then(async (res) => {
      if (!res.ok) return { style: null, versions: false };
      const data = (await res.json()) as { imageStyle?: StoredImageStyle | null; versions?: boolean };
      return { style: data.imageStyle ?? null, versions: data.versions === true };
    })
    .catch(() => ({ style: null, versions: false }));
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
    void load().then(({ style }) => {
      if (live) setState({ style, loaded: true });
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return state;
}

/**
 * Whether image style versions are on, from the same one read: the post image panel and the image
 * details show the votes' new rows only then (learning loops step 4). False until it is known.
 */
export function useImageStyleVersions(enabled = true): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void load().then(({ versions }) => {
      if (live) setOn(versions);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return on;
}
