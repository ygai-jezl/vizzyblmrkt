import { z } from "zod";

/**
 * Next article autopilot: the Learned list, Next up's picks, the brand's settings and the runs.
 * All of it is about the brand's own content and public search results: no end user's data.
 */

// ---- The Learned list (autopilot_learned) ---------------------------------------------------------

/** skipped_pick: a person said Not now to a pick. moved: an item moved between trays. left_out: the judge, or a person, left something out. */
export type LearnedKind = "skipped_pick" | "moved" | "left_out" | "added_back";

export interface LearnedEntry {
  id: string;
  tenantId: string;
  kind: LearnedKind;
  /** What it was about: a question, or a thing Google showed. */
  text: string;
  /** Why, in a few words, when someone said. */
  reason: string;
  questionId: string | null;
  from: "person" | "autopilot";
  at: string;
  by: string | null;
}

export const LEARNED_LIMITS = { TEXT: 300, REASON: 200, LIST: 200 } as const;

// ---- Settings (tenant.autopilot) -------------------------------------------------------------------

export const AUTOPILOT_CHANNELS = ["linkedin", "x", "instagram"] as const;

export const AutopilotSettingsSchema = z.object({
  /** off: nothing runs. suggest: picks and sorts, then waits for a person. draft: writes the full workflow, which waits in Review. */
  mode: z.enum(["off", "suggest", "draft"]).default("off"),
  /** 1 (Monday) to 7 (Sunday). */
  weekday: z.number().int().min(1).max(7).default(1),
  perWeek: z.number().int().min(1).max(3).default(1),
  /** What the brand wants more of right now, in its words. */
  focus: z.string().trim().max(200).default(""),
  /** The programme drafts go into. */
  workspaceId: z.string().trim().max(64).nullable().default(null),
  channels: z.array(z.enum(AUTOPILOT_CHANNELS)).max(3).default(["linkedin", "x"]),
});
export type AutopilotSettings = z.infer<typeof AutopilotSettingsSchema>;

// ---- Next up (next_up, one doc per brand) ----------------------------------------------------------

export interface NextUpChip {
  /** map: the brand map. you: the brand's own content. them: competitors. num: Google's numbers. */
  kind: "map" | "you" | "them" | "num";
  label: string;
  text: string;
}

export interface NextUpPick {
  questionId: string;
  question: string;
  subjectId: string;
  subjectName: string;
  /** Why now, in a sentence or two, from that question's own facts only. */
  because: string;
  chips: NextUpChip[];
  /** gemini: chosen and explained by the model. code: filled in by code when the model gave too few. */
  from: "gemini" | "code";
}

export interface NextUpDoc {
  id: string;
  tenantId: string;
  picks: NextUpPick[];
  /** Topics competitors write about that the brand map lacks. */
  notOnMap: Array<{ topic: string; count: number; competitors: string[] }>;
  /** What picking couldn't see (no brand search, no competitors, no Google lookups). */
  missing: string[];
  candidates: number;
  at: string;
  by: "person" | "schedule";
}

// ---- Runs (autopilot_runs) -------------------------------------------------------------------------

/** One thing found for a question, sorted into a tray. */
export interface TrayItem {
  text: string;
  /** paa: People also ask. also: people also search for. theirs: a question a competitor article answers. */
  kind: "paa" | "also" | "theirs";
  reason: string;
  /** For "Another subject": the subject it fits (a name on the map, or a new one). */
  subject: string | null;
  /** The brand's own closest page, when one is close. */
  you: string | null;
  /** The competitor that answers it, when one does. */
  them: string | null;
}

export interface Trays {
  use: TrayItem[];
  other: TrayItem[];
  drop: TrayItem[];
}

export type RunMode = "find" | "suggest" | "draft";
export type RunStep =
  | "pick"
  | "find"
  | "waiting"
  | "sort"
  | "sorted"
  | "create"
  | "seen"
  | "write"
  | "check"
  | "nodes"
  | "done"
  | "failed"
  | "stopped";

export const FINISHED_STEPS: ReadonlySet<RunStep> = new Set(["sorted", "done", "failed", "stopped"]);

export interface AutopilotRun {
  id: string;
  tenantId: string;
  mode: RunMode;
  trigger: "person" | "schedule";
  step: RunStep;
  /** Until finished. Lets "the brand's active run" be one equality query. */
  active: boolean;
  question: { questionId: string; text: string; subjectId: string; subjectName: string } | null;
  signalId: string | null;
  /** Why Google wasn't asked or didn't answer, when it wasn't or didn't ("monthly_limit", "not_set_up"). */
  googleSkipped: string | null;
  trays: Trays | null;
  workspaceId: string | null;
  planId: string | null;
  /** Nodes still to write after the hub (teaser, promo, posts). */
  nodesLeft: string[];
  /** The hub body as written, to tell whether a person has changed it since. */
  hubHash: string | null;
  /** Questions What we've seen asked the team for this article. */
  askedIds: string[];
  /** "2026-11": the month a draft counts against the cap. */
  month: string;
  /** Not advanced before this. */
  nextAt: string;
  leaseId: string | null;
  leaseUntil: string | null;
  attempts: number;
  error: string | null;
  by: string | null;
  createdAt: string;
  updatedAt: string;
}
