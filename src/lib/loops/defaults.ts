import type { MeaningKey } from "@/lib/metrics/meanings";

/**
 * The shipped priors (learning loops step 4, 3.1 of the plan for steps 4 and 5): the level a
 * verdict blends each number toward while outputs are few (src/lib/loops/verdict.ts), each with
 * its reason. They are neutral guesses, never a share measured on a brand: a measured share
 * reaches brands only as a default learned across brands, from 10 or more organisations (step 9).
 * Pure and client safe.
 */
export const SHIPPED_PRIORS = {
  likedShare: {
    value: 0.5,
    why: "Half of the images voted on are liked, a neutral guess that leans neither way before a brand has votes.",
  },
  remadeShare: {
    value: 0.25,
    why: "About one image in four is made again, a guess that only steadies the remake check while images are few.",
  },
} as const satisfies Partial<Record<MeaningKey, { value: number; why: string }>>;

export type PriorMeaning = keyof typeof SHIPPED_PRIORS;

/** The prior a verdict blends a number toward: the shipped guess, or the middle for a number with none. */
export function priorOf(meaning: MeaningKey): number {
  return (SHIPPED_PRIORS as Partial<Record<MeaningKey, { value: number }>>)[meaning]?.value ?? 0.5;
}
