"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorText, type ApiResponse } from "@/components/admin/connect/api";
import { Banner } from "@/components/admin/connect/ui";

/**
 * The move of a map at any size, run from the Brand map page (BRAND_MAP_SCALE_ENABLED): the
 * first time an admin opens the page, whichever tab is showing, the brand's subjects move
 * into their records, then its pages are read and counted, with a progress line above the
 * tabs. Until a read and count has run to the end (the map's `pagesReadAt`), the page starts
 * it again each time an admin opens it; "Read what's already there" starts it by hand. The
 * tabs read where it has got to, and read again when it finishes.
 */

const MAP = "/api/admin/brand-kit/map";
/** Calls past this many are a runaway, not a big map: 10,000 subjects are 500 recount calls. */
const MAX_CALLS = 1000;
/** Waits after "too many at once", one per refusal in a row, before giving up. */
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 60_000];

export interface MapMove {
  /** The map's subjects are in records. */
  moved: boolean;
  progress: string | null;
  /** Goes up each time a run finishes, so views read their records again. */
  round: number;
  /** "Read what's already there" and count again, for admins once the map has moved; null = not offered. */
  start: (() => void) | null;
  /** A read or count is running. */
  running: boolean;
}

const MoveContext = createContext<MapMove>({ moved: true, progress: null, round: 0, start: null, running: false });

export const useMapMove = () => useContext(MoveContext);

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Run a step-at-a-time route to the end (or until `stop`), saying how far it got. "Too many
 * at once" (429) waits and tries the same step again; any other refusal stops it.
 */
export async function runAll(
  path: string,
  say: (n: number, waiting?: boolean) => void,
  stop: () => boolean = () => false,
): Promise<{ done: true } | { done: false; refused?: ApiResponse<{ error?: string }> }> {
  let cursor: unknown = null;
  let refusals = 0;
  for (let call = 0; call < MAX_CALLS && !stop(); ) {
    const r = await api<{ done?: boolean; next?: unknown; error?: string }>(path, { method: "POST", body: JSON.stringify({ cursor }) });
    if (r.status === 429 && refusals < BACKOFF_MS.length) {
      say(call, true);
      await pause(BACKOFF_MS[refusals] ?? 60_000);
      refusals += 1;
      continue;
    }
    if (!r.ok) return { done: false, refused: r };
    refusals = 0;
    call += 1;
    say(call);
    if (r.data.done || !r.data.next) return { done: true };
    cursor = r.data.next;
  }
  return { done: false };
}

export function BrandMapMoveProvider({
  canMove,
  moved,
  readPages,
  pagesRead,
  children,
}: {
  canMove: boolean;
  moved: boolean;
  /** "Read what's already there" is on (BRAND_MAP_PAGES_ENABLED); off, only the count runs. */
  readPages: boolean;
  /** A read and count has run to the end since the move. */
  pagesRead: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState({ moved, progress: null as string | null, round: 0, running: false });
  const [error, setError] = useState<string | null>(null);
  // The page is still showing; a run is going (one at a time).
  const live = useRef(true);
  const going = useRef(false);

  const run = useCallback(
    async (move: boolean) => {
      if (going.current) return;
      going.current = true;
      setError(null);
      const say = (progress: string) => {
        if (live.current) setState((s) => ({ ...s, progress }));
      };
      const gone = () => !live.current;
      const stopped = (refused?: ApiResponse<{ error?: string }>) => {
        if (live.current) setError(`${refused ? errorText(refused.data) : "It stopped before the end."} It starts again the next time an admin opens this page.`);
      };
      setState((s) => ({ ...s, running: true }));
      try {
        if (move) {
          say("Moving your subjects into their own records…");
          const m = await api<{ ok?: boolean; error?: string }>(`${MAP}/move`, { method: "POST", body: "{}" });
          if (gone()) return;
          if (!m.ok) {
            setError(errorText(m.data));
            return;
          }
          setState((s) => ({ ...s, moved: true }));
        }
        if (readPages) {
          const read = await runAll(`${MAP}/pages`, (n, waiting) => say(`Reading what's already there (batch ${n}${waiting ? ", waiting a moment" : ""})…`), gone);
          if (gone()) return;
          if (!read.done) return stopped(read.refused);
        }
        // Counting is what marks the read done (pagesReadAt), so it runs only after a whole read.
        const count = await runAll(`${MAP}/recount`, (n, waiting) => say(`Counting what your pages answer (batch ${n}${waiting ? ", waiting a moment" : ""})…`), gone);
        if (gone()) return;
        if (!count.done) return stopped(count.refused);
        setState((s) => ({ ...s, round: s.round + 1 }));
      } finally {
        going.current = false;
        if (live.current) setState((s) => ({ ...s, progress: null, running: false }));
      }
    },
    [readPages],
  );

  useEffect(() => {
    live.current = true;
    if (canMove && (!moved || !pagesRead)) void run(!moved);
    return () => {
      live.current = false;
    };
  }, [moved, pagesRead, canMove, run]);

  const start = useCallback(() => void run(false), [run]);
  const value = useMemo<MapMove>(() => ({ ...state, start: canMove && readPages && state.moved ? start : null }), [state, canMove, readPages, start]);

  return (
    <MoveContext.Provider value={value}>
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
