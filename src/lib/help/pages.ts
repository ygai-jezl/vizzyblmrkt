/**
 * The /help pages, in reading order: one list for the help navigation, the
 * Markdown copies (`<path>.md`), /help/llms.txt, the in-app How to drawer and
 * Vizzy. Each page explains one part of setting up, in the order it's done.
 */

export type HelpGroup = "start" | "ready" | "launch" | "grow" | "product" | "retain" | "fix";

export interface HelpPage {
  /** "" for the Get set up page. */
  slug: string;
  path: string;
  /** The navigation label. */
  label: string;
  group: HelpGroup;
  /** One line for llms.txt and search. */
  summary: string;
}

/** Navigation headings, matching Home's stages. */
export const HELP_GROUPS: Array<{ key: HelpGroup; label: string }> = [
  { key: "start", label: "" },
  { key: "ready", label: "1 · Get ready" },
  { key: "launch", label: "2 · Launch" },
  { key: "grow", label: "3 · Grow audience" },
  { key: "product", label: "4 · Launch product" },
  { key: "retain", label: "5 · Onboard & retain" },
  { key: "fix", label: "Fix" },
];

const page = (slug: string, label: string, group: HelpGroup, summary: string): HelpPage => ({
  slug,
  path: slug ? `/help/${slug}` : "/help",
  label,
  group,
  summary,
});

export const HELP_PAGES: HelpPage[] = [
  page("", "Get set up", "start", "The five setup stages in order, what each one unlocks, and where the order matters."),
  page("email-sending", "Email sending", "ready", "Verify the domain you send from, then add your From address, privacy policy link and postal address."),
  page("your-brand", "Your brand", "ready", "Add your logo, colours and fonts, and write your brand voice so everything Vizzy writes sounds like you."),
  page("email-style", "Email style", "ready", "Give every email your logo, colours and fonts."),
  page("launch-and-waitlist", "Launch and waitlist", "launch", "Create a launch, turn on the welcome email, then share your waitlist page."),
  page("programmes-and-knowledge", "Programmes and knowledge", "grow", "Start a content programme and give it your website and documents to write from."),
  page("brand-map", "Brand map", "grow", "Set the names and subjects every blog article is written from."),
  page("write-and-schedule", "Write and schedule", "grow", "Write posts, articles and newsletters with Vizzy, then schedule and send them."),
  page("connected-accounts", "Connected accounts", "grow", "Connect LinkedIn or X to post, and GitHub or GitLab to read a private repo."),
  page("connect-your-product", "Connect your product", "product", "Connect your app, learn its onboarding steps from its code, and hand the rest to your developer."),
  page("invite-your-waitlist", "Invite your waitlist", "product", "Bring the people on your waitlist into your product, in waves."),
  page("onboarding-journeys", "Onboarding journeys", "retain", "Build an onboarding journey, test it on real people, then switch it to live."),
  page("review-and-approvals", "Review and approvals", "retain", "Check what Vizzy drafted and approve AI lines before they send."),
  page("people", "One person's view", "retain", "See one product user's steps, emails and journeys in one place."),
  page("troubleshooting", "Why isn't this working?", "fix", "Common symptoms, what causes them and how to fix them."),
];

export function helpPage(slug: string): HelpPage | null {
  return HELP_PAGES.find((p) => p.slug === slug) ?? null;
}

/** The page after this one in reading order, for "Next" links. */
export function nextHelpPage(slug: string): HelpPage | null {
  const i = HELP_PAGES.findIndex((p) => p.slug === slug);
  return i >= 0 ? (HELP_PAGES[i + 1] ?? null) : null;
}

/** `/help/email-sending` → `/help/email-sending.md`; the Get set up page is `/help.md`. */
export function helpMarkdownPath(p: Pick<HelpPage, "path">): string {
  return `${p.path}.md`;
}
