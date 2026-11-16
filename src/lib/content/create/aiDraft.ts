import type { ContentNode } from "@/lib/types/contentPlan";
import { isAiDraftKeptEnabled } from "./flags";

/**
 * Vizzy's draft of a post, kept beside the text a person edits (CONTENT_AI_DRAFT_KEPT_ENABLED).
 * Only LinkedIn and X posts: those are the posts whose results are read and whose edits Vizzy
 * learns from, and keeping long hubs twice would make plans much bigger. Pure.
 */

const CHANNELS = new Set(["linkedin", "x"]);

/** Whether a node on this channel keeps Vizzy's draft. */
export function keepsAiDraft(channel: string): boolean {
  return CHANNELS.has(channel);
}

/** The `aiDraft` to store with a freshly written node, or null when none is kept. */
export function aiDraftFor(
  node: Pick<ContentNode, "channel">,
  written: { body: string; status: string },
  now: string,
): NonNullable<ContentNode["aiDraft"]> | null {
  if (!isAiDraftKeptEnabled() || !keepsAiDraft(node.channel)) return null;
  if (written.status !== "generated" || !written.body.trim()) return null;
  return { body: written.body, at: now };
}
