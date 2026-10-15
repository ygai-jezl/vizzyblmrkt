"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, errorText } from "@/components/admin/connect/api";
import { Banner } from "@/components/admin/connect/ui";

/**
 * The move of a map at any size, run once from the Brand map page (BRAND_MAP_SCALE_ENABLED):
 * the first time an admin opens the page, whichever tab is showing, the brand's subjects move
 * into their records, then its pages are read and counted, with a progress line above the
 * tabs. The tabs read where it has got to, and read again when it finishes.
 */

const MAP = "/api/admin/brand-kit/map";

export interface MapMove {
  /** The map's subjects are in records. */
  moved: boolean;
  progress: string | null;
  /** Goes up each time a run finishes, so views read their records again. */
  round: number;
}

const MoveContext = createContext<MapMove>({ moved: true, progress: null, round: 0 });

export const useMapMove = () => useContext(MoveContext);

/** Run a step-at-a-time route to the end (or until `stop`), saying how far it got. */
export async function runAll(path: string, say: (n: number) => void, stop: () => boolean = () => false): Promise<boolean> {
  let cursor: unknown = null;
  for (let call = 0; call < 400 && !stop(); call += 1) {
    const r = await api<{ done?: boolean; next?: unknown }>(path, { method: "POST", body: JSON.stringify({ cursor }) });
    if (!r.ok) return false;
    say(call + 1);
    if (r.data.done || !r.data.next) return true;
    cursor = r.data.next;
  }
  return false;
}

export function BrandMapMoveProvider({ canMove, moved, children }: { canMove: boolean; moved: boolean; children: ReactNode }) {
  const [state, setState] = useState<MapMove>({ moved, progress: null, round: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (moved || !canMove) return;
    let gone = false;
    const say = (progress: string) => {
      if (!gone) setState((s) => ({ ...s, progress }));
    };
    void (async () => {
      say("Moving your subjects into their own records…");
      const m = await api<{ ok?: boolean; error?: string }>(`${MAP}/move`, { method: "POST", body: "{}" });
      if (gone) return;
      if (!m.ok) {
        setState((s) => ({ ...s, progress: null }));
        setError(errorText(m.data));
        return;
      }
      setState((s) => ({ ...s, moved: true }));
      await runAll(`${MAP}/pages`, (n) => say(`Reading what's already there (batch ${n})…`), () => gone);
      await runAll(`${MAP}/recount`, (n) => say(`Counting what your pages answer (batch ${n})…`), () => gone);
      if (!gone) setState((s) => ({ ...s, progress: null, round: s.round + 1 }));
    })();
    return () => {
      gone = true;
    };
  }, [moved, canMove]);

  return (
    <MoveContext.Provider value={state}>
      <div className="space-y-3">
        {state.progress ? (
          <p role="status" className="text-xs text-neutral-500">
            {state.progress}
          </p>
        ) : null}
        {error ? <Banner tone="err">{error}</Banner> : null}
        {children}
      </div>
    </MoveContext.Provider>
  );
}
