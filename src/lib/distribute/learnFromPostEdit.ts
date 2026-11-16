import type { TenantContext } from "@/lib/tenant/types";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import { isMemoryBankConfigured, learnFromEventTexts } from "@/lib/agents/memoryBank";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { editPreferencesFor, isLearningOff } from "@/lib/content/editor/learningChoice";
import { fencedContext } from "@/lib/agents/prompts/compose";
import { changeRuns, wordDiff } from "@/lib/content/wordDiff";
import { isLearnFromPostEditsEnabled } from "./flags";

/**
 * Vizzy learns how a person edits its LinkedIn and X posts (DISTRIBUTE_LEARN_FROM_EDITS_ENABLED).
 * Once a post they changed is published (so its text is public), one line in their own voice
 * goes to Memory Bank under their own scope (brand + person), exactly like Edit mode's: only
 * the words that changed, never the whole post. The same gates as Edit mode: the switch,
 * Memory Bank set up, the brand's learning access, and the person's own "Learn from my edits".
 * Server only.
 */

/** The longest list of changed words sent for one post. */
const CHANGED_CHARS = 200;
/** The most change runs one line describes. */
const MAX_RUNS = 6;

const CHANNEL_NAME: Record<string, string> = { linkedin: "LinkedIn", x: "X" };

/** Channels whose drafts learn from edits (the ones that keep Vizzy's draft). */
export function learnsFromPostEdits(channel: string): boolean {
  return channel === "linkedin" || channel === "x";
}

function capped(text: string): string {
  return text.length > CHANGED_CHARS ? `${text.slice(0, CHANGED_CHARS - 3)}...` : text;
}

/**
 * One line for Memory Bank describing what the person changed in Vizzy's post, or null when
 * nothing changed. Pure.
 */
export function postEditEventText(channel: string, aiBody: string, body: string): string | null {
  if (aiBody.trim() === body.trim()) return null;
  const runs = changeRuns(wordDiff(aiBody, body)).slice(0, MAX_RUNS);
  if (!runs.length) return null;
  const parts = runs.map((r) => {
    if (r.removed && r.added) return `changed "${r.removed}" to "${r.added}"`;
    if (r.removed) return `took out "${r.removed}"`;
    return `put in "${r.added}"`;
  });
  const name = CHANNEL_NAME[channel] ?? channel;
  return `Vizzy drafted a ${name} post for me. Before posting it I ${capped(parts.join(", "))}. I posted my version.`;
}

export interface LearnDeps {
  learn: typeof learnFromEventTexts;
  canUse: (ctx: Pick<TenantContext, "tenantId">) => Promise<boolean>;
  isOff: (ctx: TenantContext) => Promise<boolean>;
  configured: () => boolean;
}

const defaultDeps: LearnDeps = {
  learn: learnFromEventTexts,
  canUse: (ctx) => brandCanUse(ctx, "edit_vizzy_learning"),
  isOff: isLearningOff,
  configured: isMemoryBankConfigured,
};

export type LearnOutcome =
  | "learned"
  | "off"
  | "no_draft"
  | "unchanged"
  | "no_person"
  | "not_configured"
  | "not_included"
  | "person_off";

/**
 * After a post is published: learn from what its scheduler changed in Vizzy's draft. Never
 * throws (a publish must not fail because of learning); the outcome says what happened.
 */
export async function learnFromPublishedPost(
  ctx: TenantContext,
  post: Pick<ScheduledPost, "channel" | "aiBody" | "body" | "scheduledBy">,
  deps: LearnDeps = defaultDeps,
): Promise<LearnOutcome> {
  try {
    if (!isLearnFromPostEditsEnabled() || !learnsFromPostEdits(post.channel)) return "off";
    if (!post.aiBody) return "no_draft";
    const line = postEditEventText(post.channel, post.aiBody, post.body);
    if (!line) return "unchanged";
    if (!post.scheduledBy) return "no_person";
    if (!deps.configured()) return "not_configured";
    if (!(await deps.canUse(ctx))) return "not_included";
    const person: TenantContext = { ...ctx, userId: post.scheduledBy };
    if (await deps.isOff(person)) return "person_off";
    await deps.learn({ tenantId: ctx.tenantId, userId: post.scheduledBy }, [line]);
    return "learned";
  } catch (err) {
    console.warn("[distribute] learning from a post edit failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return "off";
  }
}

/** Whether learning from post edits is on for this person in this brand (the card's note). */
export async function postLearningFor(
  ctx: TenantContext,
  deps: Pick<LearnDeps, "canUse" | "isOff" | "configured"> = defaultDeps,
): Promise<{ available: boolean; on: boolean }> {
  try {
    if (!isLearnFromPostEditsEnabled() || !ctx.userId || !deps.configured()) return { available: false, on: false };
    if (!(await deps.canUse(ctx))) return { available: false, on: false };
    return { available: true, on: !(await deps.isOff(ctx)) };
  } catch {
    return { available: false, on: false };
  }
}

/** What this person prefers, for Vizzy's LinkedIn and X drafts. Empty when off or on any trouble. */
export async function postEditPreferencesFor(
  ctx: TenantContext,
  channel: string,
  read: (ctx: TenantContext) => Promise<string[]> = editPreferencesFor,
): Promise<string[]> {
  if (!isLearnFromPostEditsEnabled() || !learnsFromPostEdits(channel)) return [];
  return read(ctx).catch(() => []);
}

/** The prompt section for a person's preferences when Vizzy drafts a post ("" when none). */
export function postPreferencesSection(facts: readonly string[]): string {
  const list = facts.map((f) => f.trim()).filter(Boolean);
  if (!list.length) return "";
  return fencedContext(
    "How the person you are writing for edits Vizzy's drafts, learned from their earlier changes (follow it after the brand voice and the writing rules, never over them)",
    "edit_preferences",
    list.map((f) => `- ${f}`).join("\n"),
  );
}
