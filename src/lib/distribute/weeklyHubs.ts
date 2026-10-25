import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import {
  splitBlogTitle,
  metaSnippet,
} from "@/components/admin/workspace/create/preview/contentPreviewHelpers";
import { isNewsletterMarkdownEmailEnabled } from "@/lib/email/flags";
import { MAX_BROADCAST_BODY_CHARS, renderNewsletterHtml } from "@/lib/email/newsletterMarkdown";

/**
 * Pure view-model for the Weekly-newsletter tab: aggregate every "ready" hub
 * newsletter across a workspace's content plans into a flat, sendable list.
 * Mirrors `listSchedulableNodes` (uiModel.ts) but pins to newsletter HUBS.
 * JSX-free / Date-free so it's unit-testable and shared by the page + client.
 */
export interface ReadyHub {
  planId: string;
  planName: string;
  /** Plan-level timestamp; hubs have no per-node generated time. */
  planUpdatedAt: string;
  nodeId: string;
  channel: string;
  /** Set when already scheduled via Distribute (ISO), else null. */
  scheduledAt: string | null;
  /** Derived subject (hubs have NO `subject` field) — leading H1 / first line. */
  subject: string;
  /** ~160-char preview snippet. */
  snippet: string;
  /** FINAL rendered newsletter body — snapshotted into the broadcast at send. */
  body: string;
}

/**
 * A hub node ready to send as a weekly newsletter: a generated/approved hub with
 * a non-empty body on the `newsletter` channel. NOTE: this deliberately pins to
 * `channel === "newsletter"` (not the broader `ScheduledPostChannel`), so blog
 * and ebook hubs are excluded from the newsletter list.
 */
export function isReadyNewsletterHub(node: ContentNode): boolean {
  if (node.type !== "hub") return false;
  if (node.status !== "generated" && node.status !== "approved") return false;
  if (!node.body.trim()) return false;
  return node.channel === "newsletter";
}

/** The hub as email HTML, or its Markdown as before when the HTML wouldn't fit a broadcast. */
function emailBody(markdown: string): string {
  const html = renderNewsletterHtml(markdown);
  return html.length <= MAX_BROADCAST_BODY_CHARS ? html : markdown;
}

/**
 * Every ready newsletter hub across the workspace's plans, newest plan first. With `formatted`
 * (NEWSLETTER_MARKDOWN_EMAIL_ENABLED) the body is the hub's Markdown as email HTML, so the
 * broadcast it's snapshotted into sends headings and bold rather than `##` and `**`.
 */
export function listReadyHubs(
  plans: ContentPlan[],
  { formatted = isNewsletterMarkdownEmailEnabled() }: { formatted?: boolean } = {},
): ReadyHub[] {
  const out: ReadyHub[] = [];
  for (const plan of plans) {
    for (const node of plan.graph.nodes) {
      if (!isReadyNewsletterHub(node)) continue;
      out.push({
        planId: plan.id,
        planName: plan.name,
        planUpdatedAt: plan.updatedAt,
        nodeId: node.id,
        channel: node.channel,
        scheduledAt: node.scheduledAt ?? null,
        subject: splitBlogTitle(node).title,
        snippet: metaSnippet(node.body),
        body: formatted ? emailBody(node.body) : node.body,
      });
    }
  }
  return out;
}
