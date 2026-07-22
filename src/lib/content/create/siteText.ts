/**
 * Shared homepage-text reduction for the brand generators that read a tenant's website
 * (brand voice + website colours). Kept in one place so the tag-stripping and the
 * untrusted-fence hardening can never drift between callers.
 */

/** Strip tags/scripts to readable text (same approach as templatize.ts's htmlToText). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Neutralize the untrusted-fence delimiter inside site text. `htmlToText` decodes entities
 * AFTER stripping tags, so an entity-encoded `&lt;/site_text&gt;` in page copy survives as a
 * literal `</site_text>` that would close the fence early. Stripping any `<site_text>`/
 * `</site_text>` token here guarantees third-party homepage content can never break out of
 * the fence.
 */
export function stripFenceDelimiters(text: string): string {
  return text.replace(/<\/?\s*site_text[^>]*>/gi, " ");
}
