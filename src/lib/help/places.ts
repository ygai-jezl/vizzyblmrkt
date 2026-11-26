import { isPlansUiEnabled } from "@/lib/plans/flags";
import { isConnectorsScreenEnabled } from "@/lib/connectors/flags";

/**
 * Which help page explains the admin page you're on, for the header's How to
 * button. Most specific first; anything else gets Get set up. Pure and
 * client-safe. help.test.ts checks every target is a real page and section.
 */

/**
 * /help/plan-and-usage is served only with NEXT_PUBLIC_PLANS_ENABLED (fixed at build time), so
 * its rules exist only then and the How to button never opens a page that is switched off.
 */
const PLANS = isPlansUiEnabled();

/**
 * /help/connected-data is served only with NEXT_PUBLIC_CONNECTORS_ENABLED (fixed at build time), so
 * the rules for Browse, a connector's Listing, its picker and Connected exist only then. Accounts,
 * the base route, keeps Connected accounts.
 */
const CONNECTORS = isConnectorsScreenEnabled();

const RULES: Array<[RegExp, string]> = [
  [/^\/admin\/?$/, "/help"],
  [/^\/admin\/approvals/, "/help/review-and-approvals"],
  [/^\/admin\/brands\/new/, PLANS ? "/help/plan-and-usage#brands" : "/help#brand"],
  ...(PLANS ? [[/^\/admin\/account\/billing/, "/help/plan-and-usage"] as [RegExp, string]] : []),
  [/^\/admin\/launches\/new/, "/help/launch-and-waitlist#create"],
  [/^\/admin\/launches\/[^/]+\/invites/, "/help/invite-your-waitlist"],
  [/^\/admin\/launches\/[^/]+\/(journey|emails|broadcasts)/, "/help/launch-and-waitlist#welcome"],
  [/^\/admin\/launches\/[^/]+\/widget/, "/help/launch-and-waitlist#share"],
  [/^\/admin\/launches/, "/help/launch-and-waitlist"],
  [/^\/admin\/workspace\/[^/]+\/curate\/grounding/, "/help/programmes-and-knowledge#knowledge"],
  [/^\/admin\/workspace\/[^/]+\/distribute/, "/help/write-and-schedule#schedule"],
  [/^\/admin\/workspace\/[^/]+\/weekly/, "/help/write-and-schedule#newsletter"],
  [/^\/admin\/workspace\/[^/]+\/settings/, "/help/programmes-and-knowledge"],
  // The Scrapbook (curate/idea-board; Curate opens it).
  [/^\/admin\/workspace\/[^/]+\/curate(\/idea-board)?\/?$/, "/help/write-and-schedule#scrapbook"],
  [/^\/admin\/workspace\/[^/]+\/(create|templatize|curate)/, "/help/write-and-schedule#write"],
  [/^\/admin\/workspace\/[^/]+/, "/help/write-and-schedule"],
  [/^\/admin\/workspace/, "/help/programmes-and-knowledge#start"],
  // Work's pages exist only while WORK_ENABLED (a server switch) is on, so these rules are only
  // ever reached then. Each ends at a slash or the end, so /admin/workspace keeps its own.
  [/^\/admin\/work\/log(\/|$)/, "/help/work#log"],
  [/^\/admin\/work\/new(\/|$)/, "/help/work#tasks"],
  [/^\/admin\/work(\/|$)/, "/help/work"],
  [/^\/admin\/brand-kit\/images/, "/help/write-and-schedule"],
  [/^\/admin\/products/, "/help/connect-your-product"],
  [/^\/admin\/lifecycle/, "/help/onboarding-journeys"],
  [/^\/admin\/crm/, "/help/people"],
  [/^\/admin\/brand-kit\/email-style/, "/help/email-style"],
  [/^\/admin\/brand-kit\/map/, "/help/brand-map"],
  [/^\/admin\/brand-kit\/logos/, "/help/your-brand#logo"],
  [/^\/admin\/brand-kit\/voice/, "/help/your-brand#voice"],
  [/^\/admin\/brand-kit\/notes/, "/help/your-brand#seen"],
  [/^\/admin\/brand-kit/, "/help/your-brand"],
  [/^\/admin\/account\/brand/, "/help/your-brand"],
  ...(CONNECTORS
    ? ([
        [/^\/admin\/account\/connections\/connected/, "/help/connected-data#connected"],
        [/^\/admin\/account\/connections\/[^/]+/, "/help/connected-data#connect"],
      ] as Array<[RegExp, string]>)
    : []),
  [/^\/admin\/account\/connections/, "/help/connected-accounts"],
  // Settings › Data model exists only with fields on, which needs the one People list, so the page is shown.
  [/^\/admin\/account\/data-model/, "/help/your-audience#fields"],
  // Settings › Organisation exists only while sharing (CONNECTORS_SHARING_ENABLED) or the join
  // (ORGANISATION_JOIN_ENABLED) is on, both server switches this file can't read. With sharing on it
  // opens Shared connections; with only the join on, the header passes `organisation: "brands"`.
  [/^\/admin\/account\/organisation/, "/help/shared-connections"],
  [/^\/admin\/account\/?$/, "/help/email-sending"],
];

/**
 * With People on (isPeopleNameEnabled(): the switch and the one People list), the People area
 * opens the page about the one list; off, it still opens One person's view.
 */
const PEOPLE_RULES: Array<[RegExp, string]> = [[/^\/admin\/crm/, "/help/your-audience"]];

/**
 * With the join on and sharing off (from the server: isOrganisationJoinEnabled() and not
 * isConnectorsSharingEnabled()), Settings › Organisation shows only Brands, so its How to opens
 * Brands in your organisation instead of Shared connections, which isn't served then.
 */
const BRANDS_RULES: Array<[RegExp, string]> = [[/^\/admin\/account\/organisation/, "/help/organisation-brands"]];

export function helpFor(pathname: string, opts: { people?: boolean; organisation?: "brands" } = {}): string {
  const rules = [...(opts.people ? PEOPLE_RULES : []), ...(opts.organisation === "brands" ? BRANDS_RULES : []), ...RULES];
  return rules.find(([re]) => re.test(pathname))?.[1] ?? "/help";
}

/** Every help address the app links to from a page, for the tests. */
export const HELP_PLACES: string[] = [...new Set([...RULES, ...PEOPLE_RULES, ...BRANDS_RULES].map(([, to]) => to))];

/** "/help/email-sending#domain" → { slug: "email-sending", anchor: "domain" }; "/help" → slug "". */
export function parseHelpPath(path: string): { slug: string; anchor: string | null } | null {
  const m = /^\/help(?:\/([a-z0-9-]+))?\/?(?:#([a-z0-9-]+))?$/.exec(path);
  return m ? { slug: m[1] ?? "", anchor: m[2] ?? null } : null;
}
