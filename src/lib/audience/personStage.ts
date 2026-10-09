import type { ConnectionCatalog, ConsentPolicy } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { EmailSuppression } from "@/lib/types/emailSuppression";
import { DATE_START_LIMITS } from "@/lib/types/lifecycle";
import { daysSince, parseFactDate } from "@/lib/connect/dateFacts";
import { onboardingProgress } from "@/lib/lifecycle/entities";

/**
 * Where a person is, in a word, and whether they can be emailed — worked out from
 * what their product has sent, the same way for the Audience list, the person's
 * page and Vizzy's brief. Pure and client-safe.
 */

/** Signed up this recently, with no onboarding step done yet: new. */
export const NEW_FOR_DAYS = 2;
/** No new onboarding step for this long, with steps still to do: stuck. */
export const STUCK_AFTER_DAYS = 7;
/** Not active for this long: quiet (what a journey that starts when a date passes waits by default). */
export const QUIET_AFTER_DAYS = DATE_START_LIMITS.defaultDays;
/**
 * The date fact that says when a person last used the product. "Last seen" can't:
 * it moves every time the product sends their state, used or not.
 */
export const ACTIVITY_FACT = "last_active_at";

/** `member`: the product's catalog has no onboarding steps, so there's no progress to name. */
export type PersonStageKind = "new" | "onboarding" | "stuck" | "activated" | "member";

export interface PersonStage {
  kind: PersonStageKind;
  /** Onboarding steps done, of how many (0 of 0 when the catalog has none). */
  done: number;
  total: number;
  /** The step they're on, while steps remain. */
  nextStep: string | null;
  /** Whole days since their last onboarding step (or since they signed up), while steps remain. */
  daysOnStep: number | null;
  /** Whole days since they last used the product, once that's QUIET_AFTER_DAYS or more. */
  quietDays: number | null;
}

type StageUser = Pick<ProductUser, "steps" | "entities" | "activated" | "facts" | "signedUpAt" | "firstSeenAt">;

/** When the person last used the product, from the catalog's activity date fact. Null = the product doesn't say. */
export function lastActiveAt(user: Pick<ProductUser, "facts">, catalog: Partial<Pick<ConnectionCatalog, "facts">>): string | null {
  const known = (catalog.facts ?? []).some((f) => f.id === ACTIVITY_FACT && f.type === "date" && !f.kind);
  if (!known) return null;
  const ms = parseFactDate(user.facts?.[ACTIVITY_FACT]?.value);
  return ms === null ? null : new Date(ms).toISOString();
}

/** The latest onboarding step they finished, their own or one of their brands' (epoch ms). */
function lastStepMs(user: Pick<ProductUser, "steps" | "entities">): number | null {
  const times = [
    ...Object.values(user.steps ?? {}),
    ...Object.values(user.entities ?? {}).flatMap((e) => Object.values(e.steps ?? {})),
  ]
    .map((s) => Date.parse(s.doneAt))
    .filter((ms) => Number.isFinite(ms));
  return times.length ? Math.max(...times) : null;
}

export function personStage(
  user: StageUser,
  catalog: Pick<ConnectionCatalog, "onboardingSteps"> & Partial<Pick<ConnectionCatalog, "facts" | "entityKinds">>,
  nowMs: number,
): PersonStage {
  const progress = onboardingProgress(user, catalog);
  const signedUpMs = Date.parse(user.signedUpAt ?? user.firstSeenAt);
  const active = lastActiveAt(user, catalog);
  const sinceActive = active ? daysSince(Date.parse(active), nowMs) : null;
  const quietDays = sinceActive !== null && sinceActive >= QUIET_AFTER_DAYS ? sinceActive : null;
  const base = { done: progress.done, total: progress.total, quietDays };
  if (user.activated || progress.finished) return { ...base, kind: "activated", nextStep: null, daysOnStep: null };
  if (progress.total === 0) return { ...base, kind: "member", nextStep: null, daysOnStep: null };

  const fromMs = lastStepMs(user) ?? signedUpMs;
  const daysOnStep = Number.isFinite(fromMs) ? Math.max(0, daysSince(fromMs, nowMs)) : null;
  const sinceSignup = Number.isFinite(signedUpMs) ? daysSince(signedUpMs, nowMs) : null;
  const kind: PersonStageKind =
    daysOnStep !== null && daysOnStep >= STUCK_AFTER_DAYS
      ? "stuck"
      : progress.done === 0 && sinceSignup !== null && sinceSignup < NEW_FOR_DAYS
        ? "new"
        : "onboarding";
  return { ...base, kind, nextStep: progress.next?.label ?? null, daysOnStep };
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** The stage as the chips the list and the page show: what, and how it should read at a glance. */
export function stageChips(stage: PersonStage): Array<{ tone: "neutral" | "blue" | "green" | "amber"; text: string }> {
  const chips: Array<{ tone: "neutral" | "blue" | "green" | "amber"; text: string }> = [];
  if (stage.kind === "new") chips.push({ tone: "blue", text: "New" });
  if (stage.kind === "onboarding" || stage.kind === "stuck") chips.push({ tone: "blue", text: `Onboarding ${stage.done} of ${stage.total}` });
  if (stage.kind === "stuck" && stage.daysOnStep !== null) chips.push({ tone: "amber", text: `Stuck ${days(stage.daysOnStep)}` });
  if (stage.kind === "activated") chips.push({ tone: "green", text: "Activated" });
  if (stage.quietDays !== null) chips.push({ tone: "amber", text: `Quiet ${days(stage.quietDays)}` });
  return chips;
}

/** The stage in a sentence, for Vizzy's brief: "Onboarding, 2 of 5 steps done; stuck on Connect your site for 7 days". */
export function stageText(stage: PersonStage): string {
  const parts: string[] = [];
  if (stage.kind === "new") parts.push("New: signed up in the last two days, no onboarding step done yet");
  if (stage.kind === "onboarding" || stage.kind === "stuck") {
    parts.push(`Onboarding, ${stage.done} of ${stage.total} steps done`);
    if (stage.nextStep && stage.daysOnStep !== null) {
      parts.push(`${stage.kind === "stuck" ? "stuck on" : "on"} "${stage.nextStep}" for ${days(stage.daysOnStep)}`);
    }
  }
  if (stage.kind === "activated") parts.push("Activated: finished onboarding");
  if (stage.kind === "member") parts.push("A user of the product (it has no onboarding steps to follow)");
  if (stage.quietDays !== null) parts.push(`quiet: not active for ${days(stage.quietDays)}`);
  return parts.join("; ");
}

// ---- Can we email them? ------------------------------------------------------------------

export type ReachBlock = "no_address" | "excluded" | "opted_out_in_product" | "unsubscribed" | "complained" | "bounced";

export interface PersonReach {
  /** `yes`: any email. `limited`: some (service emails only, or not every category). `no`: none. */
  can: "yes" | "limited" | "no";
  /** Why nothing can be sent, when `no`. */
  blocked: ReachBlock | null;
  /** The product's own reason, for `excluded`. */
  detail: string | null;
  /** Marketing email needs a consent basis the product accepts; false = service emails only. */
  marketing: boolean;
  /** Email categories they've opted out of, in our emails or in the product (category keys). */
  optedOutOf: string[];
}

type ReachUser = Pick<ProductUser, "email" | "excluded" | "subscribed" | "consent" | "emailPreferences">;
type OptOut = Pick<EmailSuppression, "scope" | "reason"> & { category?: string | null };

const BLOCK_OF_REASON: Record<EmailSuppression["reason"], ReachBlock> = {
  unsubscribe: "unsubscribed",
  spam: "complained",
  hard_bounce: "bounced",
};

/** Whether a person can be emailed, by the rules the sender applies (stored state only). */
export function personReach(user: ReachUser, policy: Pick<ConsentPolicy, "marketingBases">, optOuts: readonly OptOut[]): PersonReach {
  // As the sender decides it (lifecycle/policy.ts `allowsMarketing`): the basis the product sent, against the connection's list.
  const marketing = policy.marketingBases.includes(user.consent?.basis ?? "none");
  const optedOutOf = [
    ...new Set([
      ...optOuts.filter((o) => o.scope === "category" && o.category).map((o) => o.category!),
      ...Object.entries(user.emailPreferences ?? {})
        .filter(([, p]) => p.subscribed === false)
        .map(([category]) => category),
    ]),
  ].sort();
  const no = (blocked: ReachBlock, detail: string | null = null): PersonReach => ({ can: "no", blocked, detail, marketing, optedOutOf });
  if (!user.email) return no("no_address");
  if (user.excluded) return no("excluded", user.excluded.reason);
  if (user.subscribed === false) return no("opted_out_in_product");
  // A bounce or a complaint says more than the unsubscribe that may sit beside it.
  const everything = optOuts.filter((o) => o.scope !== "category");
  const worst = everything.find((o) => o.reason === "hard_bounce") ?? everything.find((o) => o.reason === "spam") ?? everything[0];
  if (worst) return no(BLOCK_OF_REASON[worst.reason]);
  return { can: marketing && optedOutOf.length === 0 ? "yes" : "limited", blocked: null, detail: null, marketing, optedOutOf };
}

const BLOCK_TEXT: Record<ReachBlock, string> = {
  no_address: "No email address",
  excluded: "Excluded by your product",
  opted_out_in_product: "Opted out in your product",
  unsubscribed: "Unsubscribed from every email",
  complained: "Marked an email as spam",
  bounced: "Their address bounced",
};

/** The reach as one chip and a line of why, with each category's own name where we know it. */
export function reachText(reach: PersonReach, categoryLabels: Record<string, string> = {}): { tone: "green" | "amber" | "red"; chip: string; why: string | null } {
  if (reach.can === "no") {
    const why = reach.blocked === "excluded" && reach.detail ? `${BLOCK_TEXT.excluded}: ${reach.detail}` : BLOCK_TEXT[reach.blocked!];
    return { tone: "red", chip: "Can't email", why };
  }
  if (reach.can === "yes") return { tone: "green", chip: "Can email", why: null };
  const reasons: string[] = [];
  if (!reach.marketing) reasons.push("No marketing consent, so service emails only");
  if (reach.optedOutOf.length) reasons.push(`Opted out of ${reach.optedOutOf.map((c) => categoryLabels[c] ?? c).join(", ")}`);
  return { tone: "amber", chip: reach.marketing ? "Opted out of some emails" : "Service emails only", why: reasons.join(". ") };
}
