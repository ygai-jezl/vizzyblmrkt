import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";
import { isOneViewEnabled, isPeopleNameEnabled } from "@/lib/audience/flags";
import { isFieldsEnabled } from "@/lib/audience/peopleFlags";
import { isSearchUiEnabled } from "@/lib/search/flags";
import { isOrganisationJoinEnabled, isPlansUiEnabled } from "@/lib/plans/flags";
import { isConnectorsScreenEnabled, isConnectorsSharingEnabled } from "@/lib/connectors/flags";

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
  onlyWhen?: "site_signups" | "audience_one_view" | "search" | "plans" | "connectors" | "sharing" | "join";
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
  /** The brand map is kept at any size (isBrandMapScaleEnabled()): proposed questions wait on its Subjects tab. */
  brandMapScale?: boolean;
  /** Organisations share connections (isConnectorsSharingEnabled(), a server switch: the drawer reads it off). */
  sharing?: boolean;
  /** Owners bring in and move out brands (isOrganisationJoinEnabled(), a server switch: the drawer reads it off). */
  join?: boolean;
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
  return true;
}

/** The People list page's summary while fields are on: it names them only then. */
const AUDIENCE_SUMMARY_WITH_FIELDS =
  "Everyone from your launches, your own site and your products in one list, one page per person, your own fields on people and companies, and erasing or exporting them everywhere.";

/**
 * A page's entry in the words used now: with People on, the page about the People list is listed
 * as People, and with fields on its summary names them. Its slug stays your-audience so links and
 * llms.txt keep working.
 */
function inWords(p: HelpPage, now: { people: boolean; fields: boolean }): HelpPage {
  if (p.slug !== "your-audience") return p;
  return { ...p, ...(now.people ? { label: "People" } : {}), ...(now.fields ? { summary: AUDIENCE_SUMMARY_WITH_FIELDS } : {}) };
}

/** The pages to list now: every page, less those whose switch is off. */
export function shownHelpPages(): HelpPage[] {
  const now = { people: isPeopleNameEnabled(), fields: isFieldsEnabled() };
  return HELP_PAGES.filter(isHelpPageShown).map((p) => inWords(p, now));
}

/** One page's entry; `people` and `fields` override the server's answer (the How to drawer passes the shell's). */
export function helpPage(slug: string, opts: HelpBodyProps = {}): HelpPage | null {
  const p = HELP_PAGES.find((x) => x.slug === slug);
  return p ? inWords(p, { people: opts.people ?? isPeopleNameEnabled(), fields: opts.fields ?? isFieldsEnabled() }) : null;
}

/** The page after this one in reading order, for "Next" links (skipping pages that are switched off). */
export function nextHelpPage(slug: string): HelpPage | null {
  const i = HELP_PAGES.findIndex((p) => p.slug === slug);
  if (i < 0) return null;
  const next = HELP_PAGES.slice(i + 1).find(isHelpPageShown);
  return next ? inWords(next, { people: isPeopleNameEnabled(), fields: isFieldsEnabled() }) : null;
}

/** `/help/email-sending` → `/help/email-sending.md`; the Get set up page is `/help.md`. */
export function helpMarkdownPath(p: Pick<HelpPage, "path">): string {
  return `${p.path}.md`;
}
