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
}

export const DOC_PAGES: DocPage[] = [
  {
    slug: "",
    path: "/developers",
    label: "Overview",
    summary: "How a connection works (events, the context endpoint, webhooks), getting started, and the Node SDK.",
  },
  {
    slug: "connect-your-code",
    path: "/developers/connect-your-code",
    label: "Connecting your code",
    summary: "Read-only GitHub or GitLab access, so YouGrow can learn your product from its code.",
  },
  {
    slug: "events",
    path: "/developers/events",
    label: "Sending events",
    summary: "Sign and send identify and track events: sign-ups, onboarding steps, deletion and email preferences.",
  },
  {
    slug: "context-endpoint",
    path: "/developers/context-endpoint",
    label: "Context endpoint",
    summary: "Answer YouGrow's signed request for one user's live steps, facts and insights, or hold or stop their email.",
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
    label: "Signing & verifying",
    summary: "HMAC-signing the events you send, verifying YouGrow's ES256 tokens, reading the raw body, and test vectors.",
  },
];

/** The Markdown twin of a docs page: `/developers` → `/developers.md`. */
export function markdownPath(page: Pick<DocPage, "path">): string {
  return `${page.path}.md`;
}
