/**
 * A deliberately lightweight confidence cue for an A/B comparison — NOT a full
 * stats engine. Given two arms' (conversions, sample) it returns a coarse label
 * the UI shows next to the leader so an operator doesn't promote on noise. Uses a
 * two-proportion z-test on the larger rate vs. the other.
 */
export type Confidence = "low" | "emerging" | "clear";

export interface Proportion {
  conversions: number;
  sample: number;
}

/** Two-proportion z statistic (absolute value), or 0 when undefined. */
export function twoProportionZ(a: Proportion, b: Proportion): number {
  if (a.sample <= 0 || b.sample <= 0) return 0;
  const p1 = a.conversions / a.sample;
  const p2 = b.conversions / b.sample;
  const pPool = (a.conversions + b.conversions) / (a.sample + b.sample);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.sample + 1 / b.sample));
  if (se === 0) return 0;
  return Math.abs(p1 - p2) / se;
}

/**
 * Map the z statistic to a coarse label: |z| ≥ 1.96 (~95%) → "clear",
 * |z| ≥ 1.28 (~80%) → "emerging", else "low".
 */
export function confidenceHint(a: Proportion, b: Proportion): Confidence {
  const z = twoProportionZ(a, b);
  if (z >= 1.96) return "clear";
  if (z >= 1.28) return "emerging";
  return "low";
}
