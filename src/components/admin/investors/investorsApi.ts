import type { BoardCard, BoardColumn } from "@/lib/raise/pipeline/board";
import type { RaiseKit } from "@/lib/raise/pipeline/presets";
import type { RaiseArea } from "@/lib/raise/reasons";
import { BOARD_WORDS, REVIEW_WORDS, SETUP_WORDS } from "@/lib/raise/pipeline/words";
import { api } from "../connect/api";

/**
 * The investor and funding board's calls (RAISE_PIPELINE_ENABLED) and the message each error shows.
 * Every word is in src/lib/raise/pipeline/words.ts, which the help page quotes.
 */

export type { BoardCard, BoardColumn };

/** A field the board uses, by its id and the team's own name for it. */
export interface BoardField {
  id: string;
  label: string;
}

/** A Pass reason option the Passed dialog offers: a fixed key, or the team's own reason (key null, under Other). */
export interface ReasonChoice {
  optionId: string;
  label: string;
  key: string | null;
  area: RaiseArea;
}

/** GET /api/admin/raise/pipeline/board, set up. */
export interface BoardAnswer {
  setUp: true;
  kinds: RaiseKit[];
  kind: RaiseKit;
  tab: string;
  noun: { one: string; many: string };
  today: string;
  quietAfterDays: number;
  canMove: boolean;
  followUps: boolean;
  fields: { stage?: BoardField; passReason?: BoardField; firm?: BoardField; tier?: BoardField; lastTouch?: BoardField; nextStepDate?: BoardField };
  reasonOptions: ReasonChoice[];
  columns: BoardColumn[];
  totals: { people: number; quiet: number; nextStepPast: number; capped: boolean };
}

type Failed = { error?: string };
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

export const loadBoard = () => api<(BoardAnswer | { setUp: false }) & Failed>("/api/admin/raise/pipeline/board", { cache: "no-store" });

export interface MoveInput {
  personId: string;
  to: string;
  /** The stage the card showed, so a move from a stale board answers stale and changes nothing. */
  from: string | null;
  /** Onto Passed: the reason picked, or null for Leave it blank. */
  reason?: string | null;
}

export const moveCard = (input: MoveInput) => api<{ card?: BoardCard } & Failed>("/api/admin/raise/pipeline/move", post(input));

/** The message for a board load or a move that didn't work. */
export function boardErrorText(data: unknown): string {
  const code = (data as Failed | null)?.error;
  const errors = BOARD_WORDS.errors as Record<string, string>;
  return (code && code !== "load_failed" && errors[code]) || BOARD_WORDS.errors.other;
}

// --- Ready-made fields -------------------------------------------------------------------------

export interface SetupPreview {
  kit: RaiseKit;
  currency: string;
  firstKit: RaiseKit;
  plan: {
    addFields: Array<{ label: string; type: string }>;
    addOptions: Array<{ field: string; label: string }>;
    /** The team's own fields a press starts using, with the ready-made field each becomes. */
    adopt: Array<{ label: string; preset: string }>;
    kept: Array<{ label: string; note: string }>;
    nothing: boolean;
  };
}

export interface SetupDone {
  added: { fields: number; options: number };
  adopted: string[];
  kept: Array<{ label: string; note: string }>;
  message: string;
  rev: number;
  /** A new version was saved: fields or options added, or the team's own marked. */
  changed: boolean;
  boardHref: string;
  /** The board's tab after the press, funding only while the brand has no raising stage; null while it has no board. */
  board: RaiseKit | null;
}

export function setupPreview(kit?: RaiseKit, currency?: string) {
  const q = new URLSearchParams();
  if (kit) q.set("kit", kit);
  if (currency) q.set("currency", currency);
  const query = q.toString();
  return api<SetupPreview & Failed>(`/api/admin/raise/pipeline/setup${query ? `?${query}` : ""}`, { cache: "no-store" });
}

export const pressSetup = (kit: RaiseKit, currency: string) => api<SetupDone & Failed>("/api/admin/raise/pipeline/setup", post({ kit, currency }));

/** The message for a press that didn't work. */
export function setupErrorText(data: unknown): string {
  const code = (data as Failed | null)?.error;
  const errors = SETUP_WORDS.errors as Record<string, string>;
  return (code && code !== "other" && errors[code]) || SETUP_WORDS.errors.other;
}

// --- Follow-ups in Review ----------------------------------------------------------------------

export type FollowUpOp = "followed_up" | "dismiss";

export const decideFollowUp = (id: string, op: FollowUpOp, rev: number) =>
  api<{ ok?: boolean } & Failed>(`/api/admin/raise/pipeline/follow-ups/${encodeURIComponent(id)}`, post({ op, rev }));

/** The message for a follow-up decision that didn't save: someone else got there first, or anything else. */
export function followUpErrorText(data: unknown): string {
  const code = (data as Failed | null)?.error;
  return code === "stale" || code === "not_found" ? REVIEW_WORDS.errors.stale : REVIEW_WORDS.errors.other;
}
