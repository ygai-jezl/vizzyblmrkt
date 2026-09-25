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
}

export const DOC_PAGES: DocPage[] = [
  {
    slug: "",
    path: "/developers",
    label: "Overview",
    summary: "How a connection works (your users' state, the optional context endpoint and webhooks), getting started, and the Node SDK.",
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
    slug: "api",
    path: "/developers/api",
    label: "API reference",
    summary: "Every endpoint, field and response of API v2, rendered from the OpenAPI 3.1 spec.",
    markdown: false,
  },
];

/** Whether a page has a Markdown twin (and so a place in llms-full.txt). */
export function hasMarkdown(page: Pick<DocPage, "markdown">): boolean {
  return page.markdown !== false;
}

/** The Markdown twin of a docs page: `/developers` → `/developers.md`. */
export function markdownPath(page: Pick<DocPage, "path">): string {
  return `${page.path}.md`;
}
