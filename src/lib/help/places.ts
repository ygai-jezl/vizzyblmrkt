/**
 * Which help page explains the admin page you're on, for the header's How to
 * button. Most specific first; anything else gets Get set up. Pure and
 * client-safe. help.test.ts checks every target is a real page and section.
 */

const RULES: Array<[RegExp, string]> = [
  [/^\/admin\/?$/, "/help"],
  [/^\/admin\/approvals/, "/help/review-and-approvals"],
  [/^\/admin\/brands\/new/, "/help#brand"],
  [/^\/admin\/launches\/new/, "/help/launch-and-waitlist#create"],
  [/^\/admin\/launches\/[^/]+\/invites/, "/help/invite-your-waitlist"],
  [/^\/admin\/launches\/[^/]+\/(journey|emails|broadcasts)/, "/help/launch-and-waitlist#welcome"],
  [/^\/admin\/launches\/[^/]+\/widget/, "/help/launch-and-waitlist#share"],
  [/^\/admin\/launches/, "/help/launch-and-waitlist"],
  [/^\/admin\/workspace\/[^/]+\/curate\/grounding/, "/help/programmes-and-knowledge#knowledge"],
  [/^\/admin\/workspace\/[^/]+\/distribute/, "/help/write-and-schedule#schedule"],
  [/^\/admin\/workspace\/[^/]+\/weekly/, "/help/write-and-schedule#newsletter"],
  [/^\/admin\/workspace\/[^/]+\/settings/, "/help/programmes-and-knowledge"],
  [/^\/admin\/workspace\/[^/]+\/(create|templatize|curate)/, "/help/write-and-schedule#write"],
  [/^\/admin\/workspace\/[^/]+/, "/help/write-and-schedule"],
  [/^\/admin\/workspace/, "/help/programmes-and-knowledge#start"],
  [/^\/admin\/brand-kit\/images/, "/help/write-and-schedule"],
  [/^\/admin\/products/, "/help/connect-your-product"],
  [/^\/admin\/lifecycle/, "/help/onboarding-journeys"],
  [/^\/admin\/crm/, "/help/people"],
  [/^\/admin\/brand-kit\/email-style/, "/help/email-style"],
  [/^\/admin\/brand-kit\/map/, "/help/brand-map"],
  [/^\/admin\/brand-kit\/logos/, "/help/your-brand#logo"],
  [/^\/admin\/brand-kit\/voice/, "/help/your-brand#voice"],
  [/^\/admin\/brand-kit/, "/help/your-brand"],
  [/^\/admin\/account\/brand/, "/help/your-brand"],
  [/^\/admin\/account\/connections/, "/help/connected-accounts"],
  [/^\/admin\/account\/?$/, "/help/email-sending"],
];

export function helpFor(pathname: string): string {
  return RULES.find(([re]) => re.test(pathname))?.[1] ?? "/help";
}

/** Every help address the app links to from a page, for the tests. */
export const HELP_PLACES: string[] = [...new Set(RULES.map(([, to]) => to))];

/** "/help/email-sending#domain" → { slug: "email-sending", anchor: "domain" }; "/help" → slug "". */
export function parseHelpPath(path: string): { slug: string; anchor: string | null } | null {
  const m = /^\/help(?:\/([a-z0-9-]+))?\/?(?:#([a-z0-9-]+))?$/.exec(path);
  return m ? { slug: m[1] ?? "", anchor: m[2] ?? null } : null;
}
