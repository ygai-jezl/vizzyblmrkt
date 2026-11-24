import type { ComponentType } from "react";
import type { HelpBodyProps } from "@/lib/help/pages";

/** Each help page's body, loaded on demand: the in-app How to drawer shows one page at a time. */
export const HELP_LOADERS: Record<string, () => Promise<{ default: ComponentType<HelpBodyProps> }>> = {
  "": () => import("./pages/get-set-up"),
  "plan-and-usage": () => import("./pages/plan-and-usage"),
  "email-sending": () => import("./pages/email-sending"),
  "your-brand": () => import("./pages/your-brand"),
  "email-style": () => import("./pages/email-style"),
  "launch-and-waitlist": () => import("./pages/launch-and-waitlist"),
  "newsletter-from-your-site": () => import("./pages/newsletter-from-your-site"),
  "programmes-and-knowledge": () => import("./pages/programmes-and-knowledge"),
  "brand-map": () => import("./pages/brand-map"),
  "write-and-schedule": () => import("./pages/write-and-schedule"),
  "connected-accounts": () => import("./pages/connected-accounts"),
  "connected-data": () => import("./pages/connected-data"),
  "connect-your-product": () => import("./pages/connect-your-product"),
  "invite-your-waitlist": () => import("./pages/invite-your-waitlist"),
  "onboarding-journeys": () => import("./pages/onboarding-journeys"),
  "review-and-approvals": () => import("./pages/review-and-approvals"),
  "people": () => import("./pages/people"),
  "search": () => import("./pages/search"),
  "your-audience": () => import("./pages/your-audience"),
  "troubleshooting": () => import("./pages/troubleshooting"),
};
