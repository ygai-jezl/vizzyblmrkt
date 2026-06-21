import type { AbTest, JourneyNode } from "@/lib/types/journey";

/**
 * A/B arm assignment for a journey email send. Pure + deterministic (no clock, no
 * randomness) so the worker, retries, and late joiners all resolve the SAME arm
 * for a given (node, recipient) — which is what keeps delivery idempotent: the
 * dedupe key `journey:{journeyId}:{nodeId}:{signupId}` is unchanged, and a retry
 * re-derives the identical arm. Isomorphic, mirroring lib/journey/conditions.ts.
 *
 * Hold-out model: `splitPercent` is the % of recipients that ENTER the test
 * (distributed across the challenger variants); everyone else gets the control
 * (the node's base subject/body). The large hold-out IS the control baseline.
 */
export const CONTROL = "control" as const;

export interface Allocation {
  variantId: string;
}

/** FNV-1a (32-bit) — a tiny, stable, dependency-free string hash. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned range.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function allocateVariant(
  nodeId: string,
  signupId: string,
  abTest: AbTest | undefined,
): Allocation {
  // No live test → everyone gets control. After promotion the control copy IS
  // the winner (promoteVariant copies it into the base), so this is correct then
  // too.
  if (!abTest || !abTest.enabled || abTest.status === "promoted") {
    return { variantId: CONTROL };
  }
  const challengers = abTest.variants.map((v) => v.variantId);
  if (challengers.length === 0) return { variantId: CONTROL };

  const bucket = fnv1a(`${nodeId}:${signupId}`) % 100; // 0..99
  if (bucket >= abTest.splitPercent) return { variantId: CONTROL }; // hold-out

  // In-test cohort: spread evenly across the challengers. Independent hash stream
  // so cohort membership and arm choice don't correlate.
  const pick = fnv1a(`arm:${nodeId}:${signupId}`) % challengers.length;
  return { variantId: challengers[pick]! };
}

export interface ArmContent {
  subject: string;
  body: string;
  heroImageUrl: string | null;
}

/**
 * Resolve the email content for an allocated arm. Control (or an unknown/deleted
 * variant id — e.g. the operator removed a variant mid-test) falls back to the
 * node's base copy, so a send is never skipped or thrown.
 */
export function resolveArmContent(node: JourneyNode, variantId: string): ArmContent {
  const base: ArmContent = {
    subject: node.data.subject ?? "",
    body: node.data.body ?? "",
    heroImageUrl: node.data.heroImageUrl ?? null,
  };
  if (variantId === CONTROL) return base;
  const v = node.data.abTest?.variants.find((x) => x.variantId === variantId);
  if (!v) return base;
  return { subject: v.subject, body: v.body, heroImageUrl: v.heroImageUrl ?? null };
}
