"use client";

import { useCallback, useEffect, useState } from "react";
import type { ImageVoteView } from "@/lib/loops/learnedView";

/**
 * The browser's side of what image style learned (learning loops step 4): the learned route's
 * reads and person actions, and the vote route's vote and reason. Never throws: a failed call
 * comes back as `ok: false` with the server's message when it gave one.
 */

export const LEARNED_API = "/api/admin/brand-kit/image-style/learned";

export interface Answer<T> {
  ok: boolean;
  status: number;
  data: T & { error?: string; message?: string };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<Answer<T>> {
  try {
    const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    const data = (await res.json().catch(() => ({}))) as Answer<T>["data"];
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} as Answer<T>["data"] };
  }
}

/** A person action on what was learned (admins only). */
export function learnedAction<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<Answer<T>> {
  return call<T>(LEARNED_API, { method: "POST", body: JSON.stringify(body) });
}

/** Read the card, or one image's vote view. */
export function learnedRead<T>(query = ""): Promise<Answer<T>> {
  return call<T>(`${LEARNED_API}${query}`, { method: "GET", headers: {} });
}

/** Vote on an image: up, down or clear. */
export function voteOn(assetId: string, vote: "up" | "down" | null, rating?: number | null): Promise<Answer<{ image?: unknown }>> {
  return call(`/api/admin/brand-kit/images/${encodeURIComponent(assetId)}/feedback`, {
    method: "POST",
    body: JSON.stringify({ vote, ...(vote === "up" && rating ? { rating } : {}) }),
  });
}

/** The why behind a vote, after it saved: a reason key (or null to clear it) and an optional note. */
export function giveReason(assetId: string, reason: string | null, note: string | null): Promise<Answer<{ image?: unknown }>> {
  return call(`/api/admin/brand-kit/images/${encodeURIComponent(assetId)}/feedback`, {
    method: "POST",
    body: JSON.stringify({ reason, ...(note !== null ? { note } : {}) }),
  });
}

/**
 * One image's vote view, by its filename (a post's image) or its id (the image details), while
 * `enabled` (image style versions on). Null while off, loading or refused: the screen shows as
 * before.
 */
export function useImageVote(enabled: boolean, by: { file?: string | null; asset?: string | null; style?: string | null }): { view: ImageVoteView | null; refresh: () => void } {
  const [view, setView] = useState<ImageVoteView | null>(null);
  const [tick, setTick] = useState(0);
  const { file, asset, style } = by;
  useEffect(() => {
    if (!enabled || (!file && !asset && !style)) {
      setView(null);
      return;
    }
    let live = true;
    const q = new URLSearchParams();
    if (asset) q.set("asset", asset);
    else if (file) q.set("image", file);
    if (style) q.set("style", style);
    void learnedRead<ImageVoteView>(`?${q.toString()}`).then((r) => {
      if (live) setView(r.ok ? r.data : null);
    });
    return () => {
      live = false;
    };
  }, [enabled, file, asset, style, tick]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { view, refresh };
}
