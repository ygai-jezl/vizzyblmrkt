import type { ContentNode } from "@/lib/types/contentPlan";
import {
  ensureFooterLast,
  type EmailLayout,
  type EmailBlock,
  type EmailBlockKind,
} from "@/lib/types/emailLayout";
import { looksHtml, paragraphize, escapeHtml, sanitizeEmailHtml } from "@/lib/email/emailRender";

/** A short unique block id (kind-prefixed, ≤64 chars). */
export function newBlockId(kind: EmailBlockKind): string {
  return `${kind}_${crypto.randomUUID()}`;
}

/** A fresh block of `kind` with sensible defaults. */
export function defaultBlock(kind: EmailBlockKind): EmailBlock {
  const id = newBlockId(kind);
  switch (kind) {
    case "text":
      return { id, kind: "text", html: "<p>New paragraph…</p>" };
    case "heading":
      return { id, kind: "heading", html: "New heading", level: 2, align: "left" };
    case "image":
      return { id, kind: "image", src: "", alt: "", href: null, width: 560, align: "center" };
    case "button":
      return { id, kind: "button", label: "Get started", href: "", align: "center", bg: "#111111", color: "#ffffff", radius: 8 };
    case "divider":
      return { id, kind: "divider", color: "#e5e5e5", thickness: 1 };
    case "spacer":
      return { id, kind: "spacer", height: 24 };
    case "social":
      return { id, kind: "social", align: "center", links: [] };
    case "footer":
      return { id, kind: "footer", text: "You received this email because you signed up." };
  }
}

/** Convert an email node's current body into safe HTML for the copy text block. */
function bodyToCopyHtml(body: string): string {
  if (!body.trim()) return "<p>Your email copy…</p>";
  return looksHtml(body) ? sanitizeEmailHtml(body) : paragraphize(escapeHtml(body));
}

/**
 * The layout to open the editor with: the node's saved layout if any, otherwise a
 * starter built from the AI copy — a heading (the subject) + a role:"copy" text block
 * holding the current body, so Regenerate can later refill exactly that block.
 */
export function seedLayoutFromNode(node: ContentNode): EmailLayout {
  if (node.layout) return ensureFooterLast(structuredClone(node.layout));
  const blocks: EmailBlock[] = [
    { id: newBlockId("heading"), kind: "heading", html: node.subject || "Your heading", level: 2, align: "left" },
    { id: newBlockId("text"), kind: "text", role: "copy", html: bodyToCopyHtml(node.body) },
  ];
  // Guarantee the mandatory footer (appended last).
  return ensureFooterLast({ blocks });
}
