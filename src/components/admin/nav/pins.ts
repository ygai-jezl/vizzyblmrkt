"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Pinned launches, remembered per brand in this browser. The value is null until
 * the user first pins or unpins (the sidebar then shows its defaults). Blocked
 * storage (private windows) falls back to memory for the page's lifetime.
 */

const PREFIX = "yg:pinned-launches:";
const listeners = new Set<() => void>();
const memory = new Map<string, string>();
const parsed = new Map<string, { raw: string | null; ids: string[] | null }>();

function readRaw(tenantId: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + tenantId);
  } catch {
    return memory.get(tenantId) ?? null;
  }
}

/** Stable per raw value, as useSyncExternalStore requires. */
function snapshot(tenantId: string): string[] | null {
  const raw = readRaw(tenantId);
  const hit = parsed.get(tenantId);
  if (hit && hit.raw === raw) return hit.ids;
  let ids: string[] | null = null;
  if (raw !== null) {
    try {
      const value: unknown = JSON.parse(raw);
      ids = Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : null;
    } catch {
      ids = null;
    }
  }
  parsed.set(tenantId, { raw, ids });
  return ids;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab changed its pins.
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith(PREFIX)) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePinnedLaunchIds(tenantId: string): [string[] | null, (ids: string[]) => void] {
  const ids = useSyncExternalStore(
    subscribe,
    () => snapshot(tenantId),
    () => null, // server + hydration: defaults, so the markup matches
  );
  const save = useCallback(
    (next: string[]) => {
      const raw = JSON.stringify(next);
      try {
        window.localStorage.setItem(PREFIX + tenantId, raw);
      } catch {
        memory.set(tenantId, raw);
      }
      listeners.forEach((l) => l());
    },
    [tenantId],
  );
  return [ids, save];
}
