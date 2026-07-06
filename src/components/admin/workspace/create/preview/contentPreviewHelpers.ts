import type { ContentNode } from "@/lib/types/contentPlan";

/**
 * Pure helpers for the Create-pillar channel preview. Kept JSX-free so they can be
 * unit-tested under the `node` vitest environment (the presentational frames live in
 * ContentPreview.tsx). They decide which channel skin a node renders as, the native
 * feed-frame width each network uses, and the small text derivations (SERP snippet,
 * inbox preheader, @handle) that make the WYSIWYG read as the real surface.
 */

/** Feed = scrolling past it (truncated); opened = clicked into it (full). */
export type PreviewView = "feed" | "opened";

/** The channel skin a node renders as. `email` covers both the newsletter hub and
 *  email-sequence nodes (both render as an inbox row → opened message). */
export type PreviewKind = "linkedin" | "x" | "instagram" | "blog" | "email" | "generic";

/** Map a node to its preview skin. Email-sequence nodes (type "email") always render
 *  as email regardless of channel; otherwise the destination channel decides. */
export function previewKind(node: ContentNode): PreviewKind {
  if (node.type === "email") return "email";
  switch (node.channel) {
    case "linkedin":
      return "linkedin";
    case "x":
      return "x";
    case "instagram":
      return "instagram";
    case "blog":
      return "blog";
    case "newsletter":
      return "email";
    default:
      return "generic";
  }
}

/** Native pixel width each surface renders a post at — the "dimensions the social
 *  site would use". A few grow when opened (an article/email column is wider than its
 *  feed/inbox teaser). */
export function frameWidth(kind: PreviewKind, view: PreviewView): number {
  switch (kind) {
    case "linkedin":
      return 555;
    case "x":
      return 598;
    case "instagram":
      return 468;
    case "blog":
      return view === "opened" ? 720 : 600;
    case "email":
      return view === "opened" ? 600 : 640;
    default:
      return 560;
  }
}

/** A subtle platform-tinted backdrop behind the frame so it reads as that surface. */
export function backdropClass(kind: PreviewKind): string {
  switch (kind) {
    case "linkedin":
      return "bg-[#f4f2ee] dark:bg-neutral-900";
    case "x":
    case "instagram":
      return "bg-white dark:bg-black";
    case "email":
      return "bg-[#f6f6f6] dark:bg-neutral-900";
    default:
      return "bg-neutral-100 dark:bg-neutral-900";
  }
}

/** Strip light markdown to plain prose (for SERP snippets / inbox preheaders). */
export function toPlain(body: string): string {
  return (body ?? "")
    .replace(/`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) → text
    .replace(/[#>*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First non-empty line of the body as plain text (inbox preheader fallback). */
export function firstLine(body: string): string {
  const line = (body ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return toPlain(line ?? "");
}

/** A ~160-char meta-description snippet for the SERP card. */
export function metaSnippet(body: string, limit = 160): string {
  const plain = toPlain(body);
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Split a blog/article body into its display TITLE and the remaining body, with the
 * title REMOVED from the body so neither the SERP snippet nor the opened article ever
 * renders it twice. Precedence: a *leading* `# H1` is the title; otherwise the first
 * non-empty line is promoted to the title and dropped from the body; an empty body
 * falls back to the node role. (deriveHeading + stripLeadingH1 previously disagreed —
 * one matched an H1 on any line, the other only stripped a leading one — so a mid-body
 * heading could show up as both the title and inside the article.)
 */
export function splitBlogTitle(node: ContentNode): { title: string; body: string } {
  const raw = (node.body ?? "").replace(/\r\n/g, "\n");
  const h1 = /^\s*#\s+(.+?)[ \t]*(?:\n|$)/.exec(raw);
  if (h1?.[1]) {
    return { title: h1[1].trim().slice(0, 140), body: raw.slice(h1[0].length).replace(/^\n+/, "") };
  }
  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => l.trim() !== "");
  if (idx === -1) return { title: (node.role || "Untitled").slice(0, 140), body: "" };
  const title = (toPlain(lines[idx] ?? "") || node.role || "Untitled").slice(0, 140);
  return { title, body: lines.slice(idx + 1).join("\n").replace(/^\n+/, "") };
}

/** A plausible @handle / slug from a display name ("Your Brand" → "yourbrand"). */
export function handleFrom(name: string | undefined | null): string {
  const slug = (name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return slug || "yourbrand";
}

/** A plausible root domain for the SERP breadcrumb. */
export function domainFrom(name: string | undefined | null): string {
  return `${handleFrom(name)}.com`;
}

/** Uppercase first letter for an avatar monogram. */
export function initial(name: string | undefined | null): string {
  return (name ?? "").trim().charAt(0).toUpperCase() || "Y";
}
