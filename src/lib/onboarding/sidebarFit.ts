import { REVEALABLE, revealKeysOf, type RevealKey } from "@/lib/nav/reveal";
import { PROFILE_KEYS, type ProfileAnswers } from "@/lib/types/businessProfile";
import type { Tenant } from "@/lib/types/tenant";

/**
 * Which sidebar sections a brand sees from the start, from the four answers on the welcome
 * (ONBOARDING_ENABLED), and the line Coming up shows for each one still waiting. Pure and client
 * safe. `who` never changes the sidebar.
 *
 * Shown = Home, Review, Ideas, Brand and Settings always, plus what's stored (what fit when the
 * welcome finished, any section that holds data, Open early, a page visited), plus what fits the
 * answers now, plus the page in view. Nothing shown is ever hidden again. The canvas's stage rules
 * are dropped: behind Get ready they rarely fire, and where they do they work against the fit.
 */

/**
 * The four lines: Content when they want an audience; Products for an app that's launched or
 * established; Journeys and People when they want customers. Insights comes only with data, so it
 * never fits from the start. Blank answers fit nothing.
 */
export function fitSections(answers: ProfileAnswers): RevealKey[] {
  const fits: Record<RevealKey, boolean> = {
    content: answers.want === "audience",
    products: answers.run === "app" && (answers.stage === "launched" || answers.stage === "established"),
    journeys: answers.want === "customers",
    audience: answers.want === "customers",
    insights: false,
  };
  return REVEALABLE.filter((k) => fits[k]);
}

/** Coming up's line for each section, in the founder's terms (the mockup founders' lines). */
export function comingUpWhy(answers: ProfileAnswers): Record<RevealKey, string> {
  return {
    content: answers.want === "waitlist" ? "Comes once your waitlist is live." : "Comes when you want to grow the list.",
    products:
      answers.run === "app"
        ? "Comes when your app is ready to connect."
        : answers.run === "shop"
          ? "For apps. A shop may never need it."
          : answers.run === "service"
            ? "For apps. A service may never need it."
            : "Comes when you connect an app.",
    journeys: answers.run === "app" ? "Comes after your app is connected." : "Comes when your list starts growing.",
    audience: "Comes with your first sign-up.",
    insights: "Comes with your first sign-up or post.",
  };
}

/** At least one of the four was answered. With none, the welcome leaves today's sidebar. */
export function hasAnyAnswer(answers: ProfileAnswers): boolean {
  return PROFILE_KEYS.some((k) => answers[k] !== undefined);
}

/** What the sidebar gets from the server: the sections this brand shows, and each one's line. */
export interface SidebarReveal {
  shown: RevealKey[];
  why: Record<RevealKey, string>;
}

/**
 * The sidebar's Coming up for a brand, from the tenant doc the layout already reads; undefined
 * (today's sidebar) without `sidebarReveal`. `hasProgramme` is free from the layout's programme
 * list (archived ones too): a section with data always shows.
 */
export function sidebarRevealFor(
  tenant: Pick<Tenant, "sidebarReveal" | "businessProfile"> | null | undefined,
  facts: { hasProgramme: boolean },
): SidebarReveal | undefined {
  const stored = tenant?.sidebarReveal;
  if (!stored) return undefined;
  const answers = tenant?.businessProfile?.answers ?? {};
  const shown = new Set<RevealKey>([
    ...revealKeysOf(stored.shown),
    ...revealKeysOf(stored.opened.map((o) => o.key)),
    ...fitSections(answers),
  ]);
  if (facts.hasProgramme) shown.add("content");
  return { shown: REVEALABLE.filter((k) => shown.has(k)), why: comingUpWhy(answers) };
}
