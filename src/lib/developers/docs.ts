import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";

/**
 * The /developers pages, in reading order — one list for the docs navigation,
 * the Markdown twins (`<path>.md`), llms.txt and llms-full.txt.
 */
export interface DocPage {
  /** "" for the overview. */
  slug: string;
  path: string;
  label: string;
  /** One line for llms.txt. */
  summary: string;
  /**
   * False for a page with no Markdown twin. The API reference renders the
   * OpenAPI spec in the browser, so agents read /developers/openapi.json instead.
   */
  markdown?: false;
  /** A page about a switched-off feature: listed and served only while its switch is on. */
  onlyWhen?: "site_signups";
}

export const DOC_PAGES: DocPage[] = [
  {
    slug: "",
    path: "/developers",
    label: "Overview",
    summary: "How a connection works (your users' state, the context endpoint and webhooks), getting started, and the Node SDK.",
  },
  {
    slug: "connect-your-code",
    path: "/developers/connect-your-code",
    label: "Connecting your code",
    summary: "Read-only GitHub or GitLab access, so YouGrow can learn your product from its code.",
  },
  {
    slug: "users",
    path: "/developers/users",
    label: "Sending users",
    summary:
      "API v2: send each user's current state — sign-ups, onboarding steps, facts, opt-outs, exclusions and deletion — with the fields, responses, errors and limits.",
  },
  {
    slug: "site-signups",
    path: "/developers/site-signups",
    label: "Sign-ups from your site",
    summary:
      "Your own sign-up box: your server adds each email to a launch with its site key, and YouGrow confirms it. The call, fields, responses and limits.",
    onlyWhen: "site_signups",
  },
  {
    slug: "context-endpoint",
    path: "/developers/context-endpoint",
    label: "Context endpoint",
    summary: "Optional: answer YouGrow's signed request for one user's live steps, facts and insights just before an email, or hold or stop their email.",
  },
  {
    slug: "webhooks",
    path: "/developers/webhooks",
    label: "Webhooks",
    summary: "Receive YouGrow's signed notifications, such as an unsubscribe, and mirror them in your product.",
  },
  {
    slug: "security",
    path: "/developers/security",
    label: "Authentication",
    summary: "Authenticating your requests (HTTP Basic, secret rotation), verifying YouGrow's ES256 tokens, reading the raw body, and test vectors.",
  },
  {
    slug: "open-source",
    path: "/developers/open-source",
    label: "Open source",
    summary:
      "YouGrow is open source: run it on your laptop with no accounts, host your own copy on Google Cloud, and build on it with Claude Code or Cursor, step by step.",
  },
  {
    slug: "api",
    path: "/developers/api",
    label: "API reference",
    summary: "Every endpoint, field and response of API v2, rendered from the OpenAPI 3.1 spec.",
    markdown: false,
  },
];

/** Whether a page is listed and served now (its switch, if it has one, is on). */
export function isDocPageShown(page: Pick<DocPage, "onlyWhen">): boolean {
  return page.onlyWhen === "site_signups" ? isSiteSignupsEnabled() : true;
}

/** The pages to list now: every page, less those whose switch is off. */
export function shownDocPages(): DocPage[] {
  return DOC_PAGES.filter(isDocPageShown);
}

/** Whether a page has a Markdown twin (and so a place in llms-full.txt). */
export function hasMarkdown(page: Pick<DocPage, "markdown">): boolean {
  return page.markdown !== false;
}

/** The Markdown twin of a docs page: `/developers` → `/developers.md`. */
export function markdownPath(page: Pick<DocPage, "path">): string {
  return `${page.path}.md`;
}
