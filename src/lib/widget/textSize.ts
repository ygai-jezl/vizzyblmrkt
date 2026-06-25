/**
 * Founder-controlled text sizing for the waitlist header — the Waitlist Name
 * (`<h1>`) and the "Join N others" people-count line. Selected per launch on the
 * Design tab (see components/admin/WidgetBuilder), persisted on the campaign's
 * `configurationStyleJson` (waitlistNameSize / signupCountSize), and applied at
 * every render surface (embed widget, hosted page, admin preview).
 *
 * One Small/Medium/Large choice per element maps to a per-surface Tailwind class:
 * the hosted page renders a touch larger than the embeddable widget, exactly as
 * it did before this control existed. "md" reproduces the original hardcoded
 * sizes, so an unset (legacy) campaign is byte-for-byte unchanged.
 *
 * The class strings are LITERAL so Tailwind's content scanner emits them — never
 * build these from interpolation.
 */

export type TextSize = "sm" | "md" | "lg";

/** Where the header is rendered. The hosted page runs a step larger than embeds. */
export type TextSurface = "widget" | "hosted";

const NAME: Record<TextSurface, Record<TextSize, string>> = {
  widget: { sm: "text-lg", md: "text-xl", lg: "text-2xl" },
  hosted: { sm: "text-2xl", md: "text-3xl", lg: "text-4xl" },
};

const COUNT: Record<TextSurface, Record<TextSize, string>> = {
  widget: { sm: "text-[0.6875rem]", md: "text-xs", lg: "text-sm" },
  hosted: { sm: "text-xs", md: "text-sm", lg: "text-base" },
};

/** Tailwind font-size class for the Waitlist Name on the given surface. */
export const waitlistNameSizeClass = (surface: TextSurface, size: TextSize = "md") =>
  NAME[surface][size];

/** Tailwind font-size class for the people-count line on the given surface. */
export const signupCountSizeClass = (surface: TextSurface, size: TextSize = "md") =>
  COUNT[surface][size];

/** Validate a raw query/config value, falling back to `fallback` (default "md"). */
export function parseTextSize(raw: unknown, fallback: TextSize = "md"): TextSize {
  return raw === "sm" || raw === "md" || raw === "lg" ? raw : fallback;
}
