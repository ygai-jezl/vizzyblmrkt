import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import { isMemoryBankConfigured, learnFromEventTexts } from "@/lib/agents/memoryBank";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { editPreferencesFor, isLearningOff } from "@/lib/content/editor/learningChoice";
import {
  brandLearnFacts,
  errorCode,
  learnLogEntry,
  onceTenant,
  writeLearnLog,
  type LearnLogEntry,
  type LearnResult,
  type TenantLoad,
} from "@/lib/loops/learnLog";
import { fencedContext } from "@/lib/agents/prompts/compose";
import { changeRuns, wordDiff } from "@/lib/content/wordDiff";
import { isLearnFromPostEditsEnabled } from "./flags";

/**
 * Vizzy learns how a person edits its LinkedIn and X posts (DISTRIBUTE_LEARN_FROM_EDITS_ENABLED).
 * Once a post they changed is published (so its text is public), one line in their own voice
 * goes to Memory Bank under their own scope (brand + person), exactly like Edit mode's: only
 * the words that changed, never the whole post. Gated like Edit mode: the switch, Memory Bank set
 * up, the brand's learning access, and the person's own "Learn from my edits". Unlike Edit mode,
 * a post always needs the learning key (edit_vizzy_learning) in any region, whatever
 * EDIT_MODE_LEARNING_FOLLOWS_VIZZY_ENABLED says, until step 7 moves post edits to a regional
 * learner (ADR-0021). Server only.
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
  /** The brand's learning access; `load` reads the brand once for this and the log line. */
  canUse: (ctx: Pick<TenantContext, "tenantId">, load?: TenantLoad) => Promise<boolean>;
  isOff: (ctx: TenantContext) => Promise<boolean>;
  configured: () => boolean;
  /** Reads the brand, for its plan on the log line (defaults to getTenantById). */
  load?: TenantLoad;
  /** Where the loop_learn line goes (defaults to Cloud Logging through the console). */
  log?: (entry: LearnLogEntry) => void;
}

const defaultDeps: LearnDeps = {
  learn: learnFromEventTexts,
  canUse: (ctx, load) => brandCanUse(ctx, "edit_vizzy_learning", load),
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
 *
 * A post with something to learn (a LinkedIn or X post with Vizzy's draft, changed, and a person
 * who scheduled it) logs one loop_learn line, learned or why it skipped: switch, not_configured,
 * plan (not_included), off_by_person (person_off) or error (src/lib/loops/learnLog.ts, ADR-0021).
 * A post with nothing to learn (no_draft, unchanged, no_person, another channel) logs none. The
 * line names the brand, never the person or the words.
 */
export async function learnFromPublishedPost(
  ctx: TenantContext,
  post: Pick<ScheduledPost, "channel" | "aiBody" | "body" | "scheduledBy">,
  given: Partial<LearnDeps> = {},
): Promise<LearnOutcome> {
  const deps: LearnDeps = { ...defaultDeps, ...given };
  const load = onceTenant(deps.load ?? getTenantById);
  const logLine = async (result: LearnResult) => {
    try {
      const facts = await brandLearnFacts(ctx, load);
      // The line, and with LOOPS_ENABLED its count in the brand's week (writeLearnLog).
      await (deps.log ?? writeLearnLog)(learnLogEntry("content_write", ctx.tenantId, facts, result, 1));
    } catch {
      // A log line is never worth failing a publish over.
    }
  };
  try {
    if (!learnsFromPostEdits(post.channel)) return "off";
    if (!isLearnFromPostEditsEnabled()) {
      // Logged only for a post that had something to learn; the answer is as before.
      if (post.aiBody && post.scheduledBy && postEditEventText(post.channel, post.aiBody, post.body)) {
        await logLine({ outcome: "skipped", reason: "switch" });
      }
      return "off";
    }
    if (!post.aiBody) return "no_draft";
    const line = postEditEventText(post.channel, post.aiBody, post.body);
    if (!line) return "unchanged";
    if (!post.scheduledBy) return "no_person";
    if (!deps.configured()) {
      await logLine({ outcome: "skipped", reason: "not_configured" });
      return "not_configured";
    }
    if (!(await deps.canUse(ctx, load))) {
      await logLine({ outcome: "skipped", reason: "plan" });
      return "not_included";
    }
    const person: TenantContext = { ...ctx, userId: post.scheduledBy };
    if (await deps.isOff(person)) {
      await logLine({ outcome: "skipped", reason: "off_by_person" });
      return "person_off";
    }
    await deps.learn({ tenantId: ctx.tenantId, userId: post.scheduledBy }, [line]);
    await logLine({ outcome: "learned", via: "learning_key" });
    return "learned";
  } catch (err) {
    console.warn("[distribute] learning from a post edit failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    await logLine({ outcome: "skipped", reason: "error", code: errorCode(err) });
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
  read: (ctx: TenantContext) => Promise<string[]> = (c) => editPreferencesFor(c, "content_write"),
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
