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
