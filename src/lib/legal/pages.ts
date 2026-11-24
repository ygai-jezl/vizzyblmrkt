import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Legal pages (/privacy, /terms, /dpa) come from the deployment's own Markdown in `legal/`
 * at the repository root: `legal/privacy.md`, `legal/terms.md`, `legal/dpa.md`. The code is
 * the same for every copy of YouGrow; each copy writes its own texts, so they are kept out of
 * the public repository (scripts/lib/private-paths.mjs).
 *
 * A page shows only when its switch is on, its file exists, and its text has no `[...]`
 * placeholder left: a half-filled contract is never published.
 */
export const LEGAL_SLUGS = ["privacy", "terms", "dpa"] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

export const LEGAL_LABELS: Record<LegalSlug, string> = {
  privacy: "Privacy",
  terms: "Terms",
  dpa: "DPA",
};

/** Server switch: /privacy, /terms and their footer links. */
export function isLegalPagesEnabled(): boolean {
  return process.env.LEGAL_PAGES_ENABLED === "true";
}

/** Server switch: /dpa and its footer link. Needs LEGAL_PAGES_ENABLED. Turn on once the DPA is signed off. */
export function isLegalDpaEnabled(): boolean {
  return isLegalPagesEnabled() && process.env.LEGAL_DPA_ENABLED === "true";
}

function slugEnabled(slug: LegalSlug): boolean {
  return slug === "dpa" ? isLegalDpaEnabled() : isLegalPagesEnabled();
}

/**
 * A `[...]` left in the text, such as `[date]` or `[Company name]`. Markdown links
 * (`[text](url)`) and task boxes (`[ ]`, `[x]`) are not placeholders.
 */
export function hasPlaceholder(markdown: string): boolean {
  return /\[(?![ xX]\])[^\]\n]+\](?!\()/.test(markdown);
}

/** Where the files live: `legal/` beside package.json. */
export function legalDir(): string {
  return path.join(process.cwd(), "legal");
}

function readText(slug: LegalSlug): string | null {
  try {
    return readFileSync(path.join(legalDir(), `${slug}.md`), "utf8");
  } catch {
    return null;
  }
}

/** The page's Markdown, or null when it shouldn't show (switch off, no file, placeholder left). */
export function legalPage(slug: LegalSlug): string | null {
  if (!slugEnabled(slug)) return null;
  const text = readText(slug);
  if (!text || !text.trim() || hasPlaceholder(text)) return null;
  return text;
}

/** The legal pages that show in this deployment, in footer order. */
export function legalLinks(): { href: string; label: string }[] {
  return LEGAL_SLUGS.filter((s) => legalPage(s) !== null).map((s) => ({ href: `/${s}`, label: LEGAL_LABELS[s] }));
}

/** The page's title: its first `# ` heading, else the label. */
export function legalTitle(slug: LegalSlug, markdown: string): string {
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m?.[1]?.trim() || LEGAL_LABELS[slug];
}
