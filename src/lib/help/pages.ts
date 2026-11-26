import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";
import { isOneViewEnabled, isPeopleNameEnabled } from "@/lib/audience/flags";
import { isFieldsEnabled } from "@/lib/audience/peopleFlags";
import { isSearchUiEnabled } from "@/lib/search/flags";
import { isOrganisationJoinEnabled, isPlansUiEnabled } from "@/lib/plans/flags";
import { isConnectorsScreenEnabled, isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { isPasswordSigninAvailable } from "@/lib/auth/flags";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { isSettingsHistoryEnabled } from "@/lib/settings/flags";

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
  /**
   * A page about a switched-off feature: listed and served only while its switch is on.
   * The switches are read on the server, so client lists (⌘K) leave these pages out.
   */
  onlyWhen?: "site_signups" | "audience_one_view" | "search" | "plans" | "connectors" | "sharing" | "join" | "password_signin" | "settings_history";
}

/**
 * What a help page's body is told when it renders. Each body works it out itself on the server
 * (the /help routes, their Markdown copies, llms-full.txt); the in-app How to drawer renders on the
 * client, where server switches read off, so it passes what the admin shell was given.
 */
export interface HelpBodyProps {
  /** The Audience area is called People (isPeopleNameEnabled()). */
  people?: boolean;
  /** Fields on people and companies are on (isFieldsEnabled()). */
  fields?: boolean;
  /** People can be filtered by fields and product groups (isFieldFiltersEnabled()). */
  fieldFilters?: boolean;
  /** Admins can add someone by hand (isAddPersonEnabled()). */
  addPerson?: boolean;
  /** A person's page has a timeline (isTimelineEnabled()). */
  timeline?: boolean;
  /** Vizzy reads people's fields and suggests changes (isVizzyFieldsEnabled()). */
  vizzyFields?: boolean;
  /** Vizzy also reads text fields an admin let it read (isVizzyTextFieldsEnabled()). */
  vizzyTextFields?: boolean;
  /** Vizzy fills in the New person form (isVizzyAddPersonEnabled()). */
  vizzyAddPerson?: boolean;
  /** Every catalog save is kept as history (isCatalogHistoryEnabled()). */
  catalogHistory?: boolean;
  /** Vizzy reads connected data (isConnectorsChatEnabled()). */
  connectorsChat?: boolean;
  /** Connected data is collected daily and kept 90 days (isConnectorsCollectEnabled()). */
  connectorsCollect?: boolean;
  /** Search Console's searches are in brand search (isConnectorsSearchTextEnabled()). */
  connectorsSearchText?: boolean;
  /** Collected numbers suggest what to write (isConnectorSignalsEnabled()). */
  connectorSignals?: boolean;
  /** Next up weighs AI answers (isAiAnswersPlanningEnabled(), ADR-0019). */
  aiAnswers?: boolean;
  /** The brand map is kept at any size (isBrandMapScaleEnabled()): proposed questions wait on its Subjects tab. */
  brandMapScale?: boolean;
  /** A launch is an idea with a status, a hypothesis, an outcome and a hand-off (isIdeasEnabled()). */
  ideas?: boolean;
  /**
   * Launches are called ideas in the words people read (isIdeaWordsEnabled(): nav v2 phase 3,
   * NEXT_PUBLIC_NAV_IDEAS_ENABLED and LAUNCH_IDEAS_ENABLED). Slugs, anchors and the stage name
   * "Launch product" don't change.
   */
  ideaWords?: boolean;
  /** Organisations share connections (isConnectorsSharingEnabled(), a server switch: the drawer gets it from the admin shell). */
  sharing?: boolean;
  /** Owners bring in and move out brands (isOrganisationJoinEnabled(), a server switch: the drawer gets it from the admin shell). */
  join?: boolean;
  /** Vizzy gets to know a new brand on the welcome (isOnboardingEnabled(), a server switch: the drawer gets it from the admin shell). */
  onboarding?: boolean;
  /** Talk with Vizzy by voice on the welcome (isOnboardingVoiceEnabled(), a server switch: the drawer gets it from the admin shell). */
  onboardingVoice?: boolean;
  /** Settings › History (isSettingsHistoryEnabled(), a server switch: the drawer gets it from the admin shell). */
  settingsHistory?: boolean;
}

/** Navigation headings, matching Home's stages, in the words used while launches are called launches. */
export const HELP_GROUPS: Array<{ key: HelpGroup; label: string }> = [
  { key: "start", label: "" },
  { key: "ready", label: "1 · Get ready" },
  { key: "launch", label: "2 · Launch" },
  { key: "grow", label: "3 · Grow audience" },
  { key: "product", label: "4 · Launch product" },
  { key: "retain", label: "5 · Onboard & retain" },
  { key: "fix", label: "Fix" },
];

/**
 * The navigation headings in the words used now: with ideas in the words (`ideaWords`, the
 * server's answer unless told), stage 2 is "2 · Idea", as Home calls it. "4 · Launch product" and
 * the group keys stay.
 */
export function helpGroups(ideaWords: boolean = isIdeaWordsEnabled()): Array<{ key: HelpGroup; label: string }> {
  return ideaWords ? HELP_GROUPS.map((g) => (g.key === "launch" ? { ...g, label: "2 · Idea" } : g)) : HELP_GROUPS;
}

const page = (slug: string, label: string, group: HelpGroup, summary: string, onlyWhen?: HelpPage["onlyWhen"]): HelpPage => ({
  slug,
  path: slug ? `/help/${slug}` : "/help",
  label,
  group,
  summary,
  ...(onlyWhen ? { onlyWhen } : {}),
});

export const HELP_PAGES: HelpPage[] = [
  page("", "Get set up", "start", "The five setup stages in order, what each one unlocks, and where the order matters."),
  page(
    "plan-and-usage",
    "Plan and usage",
    "start",
    "See your plan, the brands on it and what is counted, and what happens at a limit.",
    "plans",
  ),
  page(
    "organisation-brands",
    "Brands in your organisation",
    "start",
    "Bring a brand you run into your organisation, or move one out to an organisation of its own, on the same plan.",
    "join",
  ),
  page(
    "sign-in-and-passwords",
    "Sign in and passwords",
    "start",
    "Sign in with your email and a password: create your account, confirm it with a code, reset or change your password, and sign out everywhere.",
    "password_signin",
  ),
  page("email-sending", "Email sending", "ready", "Verify the domain you send from, then add your From address, privacy policy link and postal address."),
  page("your-brand", "Your brand", "ready", "Add your logo, colours and fonts, and write your brand voice so everything Vizzy writes sounds like you."),
  page("email-style", "Email style", "ready", "Give every email your logo, colours and fonts."),
  page("launch-and-waitlist", "Launch and waitlist", "launch", "Create a launch, turn on the welcome email, then share your waitlist page."),
  page(
    "newsletter-from-your-site",
    "Newsletter from your own site",
    "launch",
    "Keep your own sign-up box: your server adds each email to a newsletter launch with a site key, and YouGrow confirms it and sends the newsletter.",
    "site_signups",
  ),
  page("programmes-and-knowledge", "Programmes and knowledge", "grow", "Start a content programme and give it your website and documents to write from."),
  page("brand-map", "Brand map", "grow", "Set the names and subjects every blog article is written from."),
  page("write-and-schedule", "Write and schedule", "grow", "Write posts, articles and newsletters with Vizzy, then schedule and send them."),
  page("search", "Search", "grow", "Find anything your brand wrote by its words or its meaning, and ask Vizzy to search it.", "search"),
  page("connected-accounts", "Connected accounts", "grow", "Connect LinkedIn or X to post, and GitHub or GitLab to read a private repo."),
  page(
    "connected-data",
    "Connected data",
    "grow",
    "Connect Google Search Console, Google Analytics 4 or Cloudflare, choose who can read each, and read the numbers live.",
    "connectors",
  ),
  page(
    "shared-connections",
    "Shared connections",
    "grow",
    "Connect Search Console, Google Analytics 4 or Cloudflare once for your organisation and give each brand its own site, property or zone.",
    "sharing",
  ),
  page(
    "your-audience",
    "Your audience",
    "grow",
    "Everyone from your launches, your own site and your products in one list, one page per person, and erasing or exporting them everywhere.",
    "audience_one_view",
  ),
  page("connect-your-product", "Connect your product", "product", "Connect your app, learn its onboarding steps from its code, and hand the rest to your developer."),
  page("invite-your-waitlist", "Invite your waitlist", "product", "Bring the people on your waitlist into your product, in waves."),
  page("onboarding-journeys", "Onboarding journeys", "retain", "Build an onboarding journey, test it on real people, then switch it to live."),
  page("review-and-approvals", "Review and approvals", "retain", "Check what Vizzy drafted and approve AI lines before they send."),
  page("people", "One person's view", "retain", "See one product user's steps, emails and journeys in one place."),
  page(
    "history-and-restore",
    "History and restore",
    "fix",
    "See every change to your fields, journeys and product catalogs, put an older version back as a new one, or download one.",
    "settings_history",
  ),
  page("troubleshooting", "Why isn't this working?", "fix", "Common symptoms, what causes them and how to fix them."),
];

/** Whether a page is listed and served now (its switch, if it has one, is on). */
export function isHelpPageShown(p: Pick<HelpPage, "onlyWhen">): boolean {
  if (p.onlyWhen === "site_signups") return isSiteSignupsEnabled();
  if (p.onlyWhen === "audience_one_view") return isOneViewEnabled();
  if (p.onlyWhen === "search") return isSearchUiEnabled();
  if (p.onlyWhen === "plans") return isPlansUiEnabled();
  if (p.onlyWhen === "connectors") return isConnectorsScreenEnabled();
  if (p.onlyWhen === "sharing") return isConnectorsSharingEnabled();
  if (p.onlyWhen === "join") return isOrganisationJoinEnabled();
  // As /login decides: the switch on and a way to deliver the code, so the page never describes
  // password screens the sign-in page doesn't show.
  if (p.onlyWhen === "password_signin") return isPasswordSigninAvailable();
  if (p.onlyWhen === "settings_history") return isSettingsHistoryEnabled();
  return true;
}

/** What a page is listed as while launches are called ideas: its slug, and so its links and anchors, stay. */
const AS_IDEAS: Readonly<Record<string, Partial<Pick<HelpPage, "label" | "summary">>>> = {
  "launch-and-waitlist": {
    label: "Idea and waitlist",
    summary: "Create an idea, turn on the welcome email, then share your waitlist page.",
  },
  "newsletter-from-your-site": {
    summary:
      "Keep your own sign-up box: your server adds each email to a waitlist just for the newsletter with a site key, and YouGrow confirms it and sends the newsletter.",
  },
};

/** The People list page's summary: it names fields only while they are on, and ideas while launches are called ideas. */
function audienceSummary(now: { fields: boolean; ideaWords: boolean }): string {
  return `Everyone from your ${now.ideaWords ? "ideas' waitlists" : "launches"}, your own site and your products in one list, one page per person, ${now.fields ? "your own fields on people and companies, " : ""}and erasing or exporting them everywhere.`;
}

/** The words used now, as the server sees them unless the caller says otherwise. */
interface Words {
  people: boolean;
  fields: boolean;
  ideaWords: boolean;
}

const wordsNow = (opts: HelpBodyProps = {}): Words => ({
  people: opts.people ?? isPeopleNameEnabled(),
  fields: opts.fields ?? isFieldsEnabled(),
  ideaWords: opts.ideaWords ?? isIdeaWordsEnabled(),
});

/**
 * A page's entry in the words used now: with People on, the page about the People list is listed
 * as People, and with fields on its summary names them. With ideas in the words, Launch and
 * waitlist is Idea and waitlist. Slugs stay, so links and llms.txt keep working.
 */
function inWords(p: HelpPage, now: Words): HelpPage {
  if (p.slug === "your-audience") {
    return {
      ...p,
      ...(now.people ? { label: "People" } : {}),
      ...(now.fields || now.ideaWords ? { summary: audienceSummary(now) } : {}),
    };
  }
  return now.ideaWords && Object.hasOwn(AS_IDEAS, p.slug) ? { ...p, ...AS_IDEAS[p.slug] } : p;
}

/**
 * The pages to list now: every page, less those whose switch is off. `ideaWords` overrides the
 * server's answer: ⌘K lists them in the browser, where server switches read off, so it passes the
 * shell's.
 */
export function shownHelpPages(opts: Pick<HelpBodyProps, "ideaWords"> = {}): HelpPage[] {
  const now = wordsNow({ ideaWords: opts.ideaWords });
  return HELP_PAGES.filter(isHelpPageShown).map((p) => inWords(p, now));
}

/** One page's entry; `people`, `fields` and `ideaWords` override the server's answer (the How to drawer passes the shell's). */
export function helpPage(slug: string, opts: HelpBodyProps = {}): HelpPage | null {
  const p = HELP_PAGES.find((x) => x.slug === slug);
  return p ? inWords(p, wordsNow(opts)) : null;
}

/**
 * The page after this one in reading order, for "Next" links (skipping pages that are switched off).
 * `ideaWords` overrides the server's answer, as the How to drawer's bodies pass it.
 */
export function nextHelpPage(slug: string, opts: Pick<HelpBodyProps, "ideaWords"> = {}): HelpPage | null {
  const i = HELP_PAGES.findIndex((p) => p.slug === slug);
  if (i < 0) return null;
  const next = HELP_PAGES.slice(i + 1).find(isHelpPageShown);
  return next ? inWords(next, wordsNow({ ideaWords: opts.ideaWords })) : null;
}

/** `/help/email-sending` → `/help/email-sending.md`; the Get set up page is `/help.md`. */
export function helpMarkdownPath(p: Pick<HelpPage, "path">): string {
  return `${p.path}.md`;
}
