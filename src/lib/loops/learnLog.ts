import type { TenantContext } from "@/lib/tenant/types";
import type { Region, Tenant } from "@/lib/types/tenant";
import type { PlanId } from "@/lib/types/organisation";
import { agentRegion } from "@/lib/agents/agentRuntime";
import { grantedOnlyFeatures } from "@/lib/plans/brandAccess";
import { activePlanOf } from "@/lib/plans/catalog";
import { isPlansEnabled } from "@/lib/plans/flags";

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
export const LEARN_KINDS = ["edit_mode", "content_write"] as const;
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

/** How a brand that learned may learn: the learning plan key, or Vizzy in Edit mode (ADR-0021). */
export type LearnVia = "learning_key" | "edit_vizzy";

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

/** The line for one outcome. Copies named fields only, so nothing else can reach a log. Pure. */
export function learnLogEntry(
  kind: LearnKind,
  tenantId: string,
  facts: BrandLearnFacts,
  result: LearnResult,
  entries?: number,
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
  };
}

/** Write a line for Cloud Logging: WARNING on stderr for an error, INFO on stdout otherwise. */
export function writeLearnLog(entry: LearnLogEntry): void {
  try {
    const line = JSON.stringify(entry);
    if (entry.severity === "WARNING") console.warn(line);
    else console.info(line);
  } catch {
    // A log line is never worth failing a request or a publish over.
  }
}
