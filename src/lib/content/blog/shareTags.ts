/**
 * The hero image in what a blog article hands over (BLOG_HERO_ENABLED). Our markup never points
 * at files we host, so the image goes in only once the person gives its address on their own
 * site (https): into the Markdown and HTML under the H1, and as share tags for the page's
 * <head> (og:image with its size and alt, and twitter:card summary_large_image). Pure and
 * client-safe.
 */

export const HERO_SIZE = { width: 1600, height: 900 } as const;
export const SHARE_SIZE = { width: 1200, height: 630 } as const;

/** An address on the client's own site we can put in their markup. */
export function isHttpsAddress(u: string | null | undefined): u is string {
  return typeof u === "string" && /^https:\/\/[^\s<>"']+$/i.test(u.trim());
}

function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function mdAlt(s: string): string {
  return s.replace(/[[\]\\]/g, "").replace(/\s+/g, " ").trim();
}

/** The Markdown with the hero right under its H1 (or at the top when it has none). */
export function withHeroMarkdown(markdown: string, image: { url: string; alt: string }): string {
  if (!isHttpsAddress(image.url)) return markdown;
  const line = `![${mdAlt(image.alt)}](${image.url.trim()})`;
  const h1 = /^# .*$/m.exec(markdown);
  if (!h1) return `${line}\n\n${markdown}`;
  const end = h1.index + h1[0].length;
  return `${markdown.slice(0, end)}\n\n${line}${markdown.slice(end)}`;
}

/** The HTML with the hero right under its <h1> (or first in the article when it has none). */
export function withHeroHtml(html: string, image: { url: string; alt: string }): string {
  if (!isHttpsAddress(image.url)) return html;
  const img = `<img src="${attr(image.url.trim())}" alt="${attr(image.alt)}" width="${HERO_SIZE.width}" height="${HERO_SIZE.height}">`;
  const h1 = /<\/h1>/i.exec(html);
  if (h1) return `${html.slice(0, h1.index + h1[0].length)}\n${img}${html.slice(h1.index + h1[0].length)}`;
  return html.replace(/<article>/i, (m) => `${m}\n${img}`);
}

export interface ShareTagsInput {
  /** The hero's address on the client's site. */
  imageUrl?: string | null;
  /** The share card's address on the client's site (better for previews); optional. */
  shareImageUrl?: string | null;
  alt: string;
  title: string;
  description: string;
  pageUrl?: string | null;
}

/**
 * The tags that make the article's link preview show the image, for the page's <head>. The
 * share card when there's an address for it, else the hero. Null without an https image.
 */
export function shareTags(input: ShareTagsInput): string | null {
  const share = isHttpsAddress(input.shareImageUrl) ? input.shareImageUrl.trim() : null;
  const hero = isHttpsAddress(input.imageUrl) ? input.imageUrl.trim() : null;
  const image = share ?? hero;
  if (!image) return null;
  const size = share ? SHARE_SIZE : HERO_SIZE;
  const tags: [string, string, string][] = [
    ["property", "og:type", "article"],
    ...(input.title ? ([["property", "og:title", input.title]] as [string, string, string][]) : []),
    ...(input.description ? ([["property", "og:description", input.description]] as [string, string, string][]) : []),
    ...(isHttpsAddress(input.pageUrl) ? ([["property", "og:url", input.pageUrl.trim()]] as [string, string, string][]) : []),
    ["property", "og:image", image],
    ["property", "og:image:width", String(size.width)],
    ["property", "og:image:height", String(size.height)],
    ...(input.alt ? ([["property", "og:image:alt", input.alt]] as [string, string, string][]) : []),
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:image", image],
    ...(input.alt ? ([["name", "twitter:image:alt", input.alt]] as [string, string, string][]) : []),
  ];
  return tags.map(([k, n, v]) => `<meta ${k}="${n}" content="${attr(v)}">`).join("\n");
}
