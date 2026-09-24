import type { NavKey } from "./model";
import { isInsightsHubEnabled } from "./flags";
import { isInvitesUiEnabled } from "@/lib/invites/flags";

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

/** Nav v2 phase 4: extra starters that only make sense while their feature is on. */
const INVITE_SUGGESTION = "Draft an invite wave for my top 100";
/** Answered from real numbers by Vizzy's get_insights_summary tool. */
const INSIGHTS_SUGGESTION = "Which content brings signups?";

export function vizzySuggestions(key: NavKey | null): string[] {
  const base = SUGGESTIONS[key ?? "home"];
  if (key === "launches" && isInvitesUiEnabled()) return [...base, INVITE_SUGGESTION];
  if (key === "insights" && isInsightsHubEnabled()) return [...base, INSIGHTS_SUGGESTION];
  return base;
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
  const base = HOME_PROMPTS[stage ?? "retain"];
  return stage === "product" && isInvitesUiEnabled() ? [...base, "Invite my waitlist to the product"] : base;
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
/**
 * The content programme (and plan) in view, for Vizzy's content tools (nav v2
 * phase 4): /admin/workspace/{programme}/… and …/create/{plan}. Ids are
 * brace-free by construction (they ride inside the chat's [ctx:{…}] envelope).
 */
export function programmeInView(pathname: string): { workspaceId: string | null; planId: string | null } {
  const m = /^\/admin\/workspace\/([A-Za-z0-9_-]+)(?:\/create\/([A-Za-z0-9_-]+))?/.exec(pathname);
  if (!m || m[1] === "new") return { workspaceId: null, planId: null };
  return { workspaceId: m[1]!, planId: m[2] ?? null };
}

export function launchInView(pathname: string): string | null {
  const m = /^\/admin\/launches\/([^/]+)/.exec(pathname);
  if (!m || m[1] === "new") return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}
