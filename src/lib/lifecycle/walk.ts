import type { EnrolmentRuntime, LifecycleVersion } from "@/lib/types/lifecycle";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { ProductContext } from "@/lib/connect/protocol";
import type { WalkEnv, WalkState } from "./planner";
import { personalOffsetMinutes, resolveTimezone } from "./sendWindow";
import { buildRecipientContext } from "./recipientContext";

/**
 * The walk inputs for one enrolment, built the same way wherever the runtime
 * needs to ask "what happens next for this person?" — the runner (to act) and
 * the draft preparer (to predict which email a person will get).
 */

export function walkStateOf(
  e: Pick<EnrolmentRuntime, "cursor" | "anchorAt" | "lastSentAt" | "windowExemptUntil" | "sentItems">,
  nowMs: number,
): WalkState {
  return {
    cursor: e.cursor?.nodeId ?? null,
    nowMs,
    anchorMs: Date.parse(e.anchorAt),
    lastSentMs: e.lastSentAt ? Date.parse(e.lastSentAt) : null,
    windowExemptUntilMs: e.windowExemptUntil ? Date.parse(e.windowExemptUntil) : null,
    sent: e.sentItems.map((s) => ({ poolId: s.poolId, itemId: s.itemId, status: s.status })),
  };
}

export function recipientClock(
  user: Pick<ProductUser, "id" | "timezone">,
  connection: Pick<ProductConnection, "defaults">,
  version: Pick<LifecycleVersion, "settings">,
): { tz: string; offsetMin: number } {
  const policy = version.settings.sendPolicy;
  return {
    tz: resolveTimezone(user.timezone, connection.defaults.timezone, policy.fallbackTimezone),
    offsetMin: personalOffsetMinutes(user.id, policy),
  };
}

export function walkEnvFor(a: {
  version: Pick<LifecycleVersion, "graph" | "pools" | "settings">;
  user: ProductUser;
  connection: Pick<ProductConnection, "catalog">;
  context: ProductContext | null;
  tz: string;
  offsetMin: number;
  anchorMs: number;
  /** How many emails the person has had (read lazily — it changes during a run). */
  emailsSent: () => number;
  excluded?: ReadonlySet<string>;
  /** Set when the walk reads the person's state (a condition or a pool pick). */
  probe?: { used: boolean };
}): WalkEnv {
  return {
    graph: a.version.graph,
    pools: a.version.pools,
    policy: a.version.settings.sendPolicy,
    tz: a.tz,
    offsetMin: a.offsetMin,
    excluded: a.excluded,
    recipientAt: (atMs) => {
      if (a.probe) a.probe.used = true;
      return buildRecipientContext({
        user: a.user,
        connection: a.connection,
        context: a.context,
        emailsSent: a.emailsSent(),
        enrolledAtMs: a.anchorMs,
        nowMs: atMs,
      });
    },
  };
}
