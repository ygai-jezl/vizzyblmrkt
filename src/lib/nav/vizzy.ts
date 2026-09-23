import type { NavKey } from "./model";

/**
 * Starter questions for the Ask Vizzy panel, by the area in view. Written as the
 * admin would ask them; each one works on its own (Vizzy also knows the page).
 */
const SUGGESTIONS: Record<NavKey, string[]> = {
  home: ["What should I do next?", "How are signups this week?"],
  review: ["What needs me first?", "What happens if I don't decide in time?"],
  launches: ["Draft a broadcast for this launch", "Write a referral nudge for people who haven't shared"],
  content: ["Plan next week's posts", "Draft this week's newsletter"],
  products: ["Explain the context endpoint to my developer", "What did you learn from our repo?"],
  journeys: ["Draft a re-engagement journey", "Suggest a split for people who stall at step 2"],
  audience: ["Who joined this week?", "Which companies have several signups?"],
  insights: ["What drove signups this week?", "Which email has the best click rate?"],
  brand: ["Tighten our brand voice for email", "Write do and don't examples for our voice"],
  settings: ["Which integrations are connected?", "Is our sending domain set up?"],
};

export function vizzySuggestions(key: NavKey | null): string[] {
  return SUGGESTIONS[key ?? "home"];
}

/** Prompts on Home, for the stage the brand is in ("first" = nothing set up yet). */
const HOME_PROMPTS: Record<"first" | "launch" | "grow" | "product" | "retain", string[]> = {
  first: ["Help me plan a launch for my idea", "What should I set up first?"],
  launch: ["Write a nudge for people who haven't shared their link", "Draft a broadcast announcing our beta dates"],
  grow: ["Plan next week's posts around what's working", "Draft this week's newsletter"],
  product: ["Explain the context endpoint to my developer", "What did you learn from our repo?"],
  retain: ["Draft a journey for users who go quiet for 7 days", "Which onboarding step do people stall on?"],
};

export function homePrompts(stage: keyof typeof HOME_PROMPTS | null): string[] {
  return HOME_PROMPTS[stage ?? "retain"];
}

/** Characters the `[ctx:{...}]` envelope can't carry (see the chat route's `page` rule). */
const UNSAFE = /[{}[\]\\"]/g;

/** The page label sent to Vizzy: breadcrumb text, envelope-safe, at most 160 chars. */
export function vizzyPageLabel(crumbs: Array<{ label: string }>): string {
  return crumbs
    .map((c) => c.label)
    .join(" › ")
    .replace(UNSAFE, "")
    .slice(0, 160);
}

/** The launch in view on /admin/launches/[id]/…, for Vizzy's campaign context. */
export function launchInView(pathname: string): string | null {
  const m = /^\/admin\/launches\/([^/]+)/.exec(pathname);
  if (!m || m[1] === "new") return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}
