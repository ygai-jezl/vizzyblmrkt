import { kindLabel, onboardingProgress, type Catalog } from "@/lib/lifecycle/entities";
import type { ProductUser } from "@/lib/types/productUser";

/**
 * One person's onboarding, as the admin tables show it — the same count
 * journeys and activation use (onboardingProgress), whether the catalog has 2
 * steps or 20, per person, per brand or both. Plain data, so the Audience API
 * can send it as it is.
 */
export interface OnboardingSummary {
  done: number;
  total: number;
  activated: boolean;
  /** The first step not done. */
  next: string | null;
  /** Whose steps count when some are per entity, e.g. "Acme (+1 brand)". */
  about: string | null;
  /** The steps in order, for the hover detail. */
  steps: Array<{ label: string; done: boolean }>;
}

export function onboardingSummary(
  user: Pick<ProductUser, "steps" | "entities" | "activated">,
  catalog: Catalog,
): OnboardingSummary {
  const p = onboardingProgress(user, catalog);
  const about = p.focus
    .map((f) => {
      const name = f.name ?? `their ${kindLabel(f.kind, catalog)}`;
      return f.others > 0 ? `${name} (+${f.others} ${kindLabel(f.kind, catalog, f.others > 1)})` : name;
    })
    .join(" · ");
  return {
    done: p.done,
    total: p.total,
    activated: Boolean(user.activated),
    next: p.next?.label ?? null,
    about: about || null,
    steps: p.checklist.map((s) => ({ label: s.label, done: s.done })),
  };
}
