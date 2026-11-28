import type { TenantContext } from "@/lib/tenant/types";
import type { Region, Tenant } from "@/lib/types/tenant";
import type { PlanId } from "@/lib/types/organisation";
import { agentRegion } from "@/lib/agents/agentRuntime";
import { grantedOnlyFeatures } from "@/lib/plans/brandAccess";
import { activePlanOf } from "@/lib/plans/catalog";
import { isPlansEnabled } from "@/lib/plans/flags";
import { countLearnOutcome, type CountDeps } from "./count";
import { isLoopsEnabled } from "./flags";

/**
 * One structured log line for every Memory Bank learn YouGrow tries or skips (learning loops step
 * 2, ADR-0021 in docs/DECISIONS.md), so a week of logs shows why brands stall. Cloud Logging reads
 * a JSON line as jsonPayload: filter on jsonPayload.event="loop_learn". A line says which kind
 * tried, whether it learned or why it skipped, and the brand's plan and region.
 *
 * It never carries text a person wrote, a memory, an email or a person id: `learnLogEntry` copies
 * named fields only, and an error becomes a short code or "other". The brand's id is there, as in
 * the app's other logs. Not behind a switch: it writes no data and must run where the stall is.
 * Server only.
 */

/** Learning registry kinds (src/lib/loops/registry.ts) that learn through Memory Bank. */
export const MEMORY_BANK_KINDS = ["edit_mode", "content_write"] as const;
export type MemoryBankKind = (typeof MEMORY_BANK_KINDS)[number];

/**
 * Kinds a line can name: the Memory Bank kinds, from learning loops step 4 the loops' own learners
 * (loop_learn), whose lines also name the scope they learned for, and from step 5 the post patterns
 * learner (post_feedback), whose judge writes a line each time it defers, naming the channel as
 * its scope (src/lib/distribute/feedback/patterns.ts).
 */
export const LEARN_KINDS = [...MEMORY_BANK_KINDS, "loop_learn", "post_feedback"] as const;
export type LearnKind = (typeof LEARN_KINDS)[number];

/**
 * Why a learn was skipped. The design's fixed list, plus the person's own "Learn from my edits"
 * (off_by_person), which is separate from the switch. Memory Bank paths give switch, budget (the
 * per person rate limit), region, plan, not_configured, error and off_by_person; paused, floor,
 * full and trust are kept for the loops' own learners.
 */
export const LEARN_REASONS = [
  "switch",
  "paused",
  "floor",
  "budget",
  "full",
  "trust",
  "region",
  "plan",
  "not_configured",
  "error",
  "off_by_person",
] as const;
export type LearnReason = (typeof LEARN_REASONS)[number];

/** How a brand that learned may learn: the learning plan key, Vizzy in Edit mode (ADR-0021), or the loops' votes learner. */
export type LearnVia = "learning_key" | "edit_vizzy" | "votes";

/** What happened, as a line says it. */
export type LearnResult = { outcome: "learned"; via: LearnVia } | { outcome: "skipped"; reason: LearnReason; code?: string };

/** The plan key that holds learning from edits back (src/lib/plans/brandAccess.ts). */
const LEARNING_KEY = "edit_vizzy_learning";

/** The brand's side of a line, read with no more than brand access already reads. */
export interface BrandLearnFacts {
  /** The plan that decides, "plans_off" with plans off, "none" when the brand has no known plan. */
  plan: PlanId | "none" | "plans_off";
  /** Whether the brand's own grant includes the learning key; null when access needed no read. */
  granted: boolean | null;
  /** Whether this copy keeps the learning key for granted brands only (GRANTED_ONLY_FEATURES). */
  grantedOnly: boolean;
  /** Where the brand keeps its data. */
  region: Region;
  /** The data region the agent, and so Memory Bank, runs in; null for a location outside them. */
  agentRegion: Region | null;
  /** Edit mode only: whether the brand may use Vizzy in Edit mode (edit_vizzy). */
  editVizzy?: boolean;
}

export interface LearnLogEntry extends BrandLearnFacts {
  severity: "INFO" | "WARNING";
  message: string;
  event: "loop_learn";
  kind: LearnKind;
  outcome: LearnResult["outcome"];
  /** Why it skipped; null when it learned. */
  reason: LearnReason | null;
  tenantId: string;
  /** How it may learn, on a learned line. */
  via?: LearnVia;
  /** How many changes the visit or post had. A count, never what they were. */
  entries?: number;
  /** For a loops learner, the scope it learned for, such as image_style.natural_photo. */
  scope?: string;
  /** On an error: a short code such as memory_bank_404, or "other". */
  code?: string;
}

export type TenantLoad = (id: string) => Promise<Tenant | null>;

/** A loader for one brand that reads it at most once, however often brand access asks. */
export function onceTenant(load: TenantLoad): TenantLoad {
  let got: Promise<Tenant | null> | null = null;
  return (id) => (got ??= Promise.resolve().then(() => load(id)));
}

/**
 * The brand's plan, grant and regions for a line. Reads the brand only when brand access would
 * (plans on, or the key kept for granted brands), so with `onceTenant` it adds no read.
 */
export async function brandLearnFacts(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  load: TenantLoad,
  editVizzy?: boolean,
): Promise<BrandLearnFacts> {
  const plansOn = isPlansEnabled();
  const grantedOnly = grantedOnlyFeatures().has(LEARNING_KEY);
  const read = plansOn || grantedOnly;
  const tenant = read ? await Promise.resolve().then(() => load(ctx.tenantId)).catch(() => null) : null;
  return {
    plan: plansOn ? (activePlanOf(tenant ?? null, true)?.id ?? "none") : "plans_off",
    granted: read ? Boolean(tenant?.grantedFeatures?.includes(LEARNING_KEY)) : null,
    grantedOnly,
    region: ctx.region,
    agentRegion: agentRegion(),
    ...(editVizzy === undefined ? {} : { editVizzy }),
  };
}

const CODE = /^[a-z0-9_]{1,60}$/;

/** An error as a code a line may carry: the app's own codes (memory_bank_500), else "other". */
export function errorCode(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return CODE.test(message) ? message : "other";
}

const MAX_ENTRIES = 1000;

/** A scope a line may carry: lower case words joined by dots, at most 40 characters. */
const SCOPE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

/** The line for one outcome. Copies named fields only, so nothing else can reach a log. Pure. */
export function learnLogEntry(
  kind: LearnKind,
  tenantId: string,
  facts: BrandLearnFacts,
  result: LearnResult,
  entries?: number,
  scope?: string,
): LearnLogEntry {
  const reason = result.outcome === "skipped" ? result.reason : null;
  const code = result.outcome === "skipped" && result.code !== undefined ? errorCode(result.code) : undefined;
  return {
    severity: reason === "error" ? "WARNING" : "INFO",
    message: `[loops] ${kind} ${result.outcome}${reason ? `: ${reason}` : ""}`,
    event: "loop_learn",
    kind,
    outcome: result.outcome,
    reason,
    tenantId,
    plan: facts.plan,
    granted: facts.granted,
    grantedOnly: facts.grantedOnly,
    region: facts.region,
    agentRegion: facts.agentRegion,
    ...(typeof facts.editVizzy === "boolean" ? { editVizzy: facts.editVizzy } : {}),
    ...(result.outcome === "learned" ? { via: result.via } : {}),
    ...(code ? { code } : {}),
    ...(Number.isInteger(entries) && entries! >= 0 && entries! <= MAX_ENTRIES ? { entries } : {}),
    ...(scope && scope.length <= 40 && SCOPE.test(scope) ? { scope } : {}),
  };
}

/**
 * The line the Edit mode memory list writes when Memory Bank fails it (a 403 or a 5xx; a 404 is an
 * empty list). Edit mode then closes with only a count, which the learn route logs as error
 * not_loaded, the same as closing before the list loaded; this line says what the bank answered.
 * Not a loop_learn line and no kind: it counts list reads, and Distribute's card reads the same
 * list. Named fields only, as learnLogEntry. Pure.
 */
export interface MemoryListLogEntry {
  severity: "WARNING";
  message: string;
  event: "memory_list_failed";
  tenantId: string;
  region: Region;
  agentRegion: Region | null;
  /** The app's own code, such as memory_bank_403, or "other". */
  code: string;
}

export function memoryListLogEntry(ctx: Pick<TenantContext, "tenantId" | "region">, err: unknown): MemoryListLogEntry {
  const code = errorCode(err);
  return {
    severity: "WARNING",
    message: `[loops] memory list failed: ${code}`,
    event: "memory_list_failed",
    tenantId: ctx.tenantId,
    region: ctx.region,
    agentRegion: agentRegion(),
    code,
  };
}

/**
 * Write a line for Cloud Logging: WARNING on stderr for an error, INFO on stdout otherwise. With
 * LOOPS_ENABLED on, a Memory Bank kind's line is also counted in the brand's week (learning loops
 * step 5, 4.4): `r.<kind>.learned`, or `r.<kind>.<reason>` for a skip, so the stages show the
 * Memory Bank learning or stalling. The line's brand and region are the server's own, copied from
 * the request's context by learnLogEntry. The loops' own learners count their outcomes themselves.
 * The promise settles once the count is written; it never rejects, so a caller may leave it.
 */
export function writeLearnLog(entry: LearnLogEntry | MemoryListLogEntry, deps: CountDeps = {}): Promise<void> {
  try {
    const line = JSON.stringify(entry);
    if (entry.severity === "WARNING") console.warn(line);
    else console.info(line);
  } catch {
    // A log line is never worth failing a request or a publish over.
  }
  return countLogged(entry, deps);
}

/** A Memory Bank line's outcome, counted. Never throws. */
async function countLogged(entry: LearnLogEntry | MemoryListLogEntry, deps: CountDeps): Promise<void> {
  if (entry.event !== "loop_learn" || !isLoopsEnabled()) return;
  const kind = entry.kind;
  if (!(MEMORY_BANK_KINDS as readonly string[]).includes(kind)) return;
  const outcome = entry.outcome === "learned" ? "learned" : entry.reason;
  if (!outcome) return;
  try {
    await countLearnOutcome({ tenantId: entry.tenantId, region: entry.region, source: "system" }, kind as MemoryBankKind, outcome, deps);
  } catch {
    // Counting never fails what it counts.
  }
}
