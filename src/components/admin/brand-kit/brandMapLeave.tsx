"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";

/**
 * Leaving the Brand map page by one of its own links (an article, "Write this next", a page in
 * "Needs a look" or on the content map) asks first while the map has unsaved changes. A link
 * between tabs of an app doesn't fire `beforeunload`, which only covers closing the page.
 */

const Unsaved = createContext<{ dirty: boolean; setDirty: (dirty: boolean) => void } | null>(null);

export function BrandMapLeaveGuard({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState(false);
  const value = useMemo(() => ({ dirty, setDirty }), [dirty]);
  return <Unsaved.Provider value={value}>{children}</Unsaved.Provider>;
}

/** The editor says whether it has unsaved changes. */
export function useReportUnsaved(dirty: boolean): void {
  const setDirty = useContext(Unsaved)?.setDirty;
  useEffect(() => {
    setDirty?.(dirty);
    return () => setDirty?.(false);
  }, [setDirty, dirty]);
}

const ASK = "Your brand map has changes you haven't saved. Leave without saving them?";

/** A link's click handler that asks before leaving unsaved changes behind. */
export function useLeaveGuard(): (e: MouseEvent) => void {
  const dirty = Boolean(useContext(Unsaved)?.dirty);
  return useCallback(
    (e: MouseEvent) => {
      if (dirty && !window.confirm(ASK)) e.preventDefault();
    },
    [dirty],
  );
}
