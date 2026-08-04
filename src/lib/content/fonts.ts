import type { TextStyle, TextStyleRole } from "@/lib/types/tenant";

/**
 * Curated font families offered in the Brand Kit → Fonts "Choose a font" picker, plus the
 * default text-style seed. Pure + client-safe (no server imports) so both the Fonts manager
 * (client) and any server surface can import it. Uploaded custom fonts (brand_fonts) are
 * appended to this list at render time by the manager.
 *
 * `stack` is the CSS fallback chain used for in-app preview. System families render exactly;
 * common Google families fall back gracefully until a follow-on loads their webfonts. Custom
 * uploaded fonts render truly via the @font-face the manager injects from the proxy URL.
 */
export interface CuratedFont {
  family: string;
  stack: string;
}

const SANS = "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
const SERIF = "Georgia, Cambria, 'Times New Roman', Times, serif";

export const CURATED_FONTS: CuratedFont[] = [
  { family: "Inter", stack: `Inter, ${SANS}` },
  { family: "Roboto", stack: `Roboto, ${SANS}` },
  { family: "Open Sans", stack: `'Open Sans', ${SANS}` },
  { family: "Lato", stack: `Lato, ${SANS}` },
  { family: "Montserrat", stack: `Montserrat, ${SANS}` },
  { family: "Poppins", stack: `Poppins, ${SANS}` },
  { family: "Nunito", stack: `Nunito, ${SANS}` },
  { family: "Work Sans", stack: `'Work Sans', ${SANS}` },
  { family: "Raleway", stack: `Raleway, ${SANS}` },
  { family: "Playfair Display", stack: `'Playfair Display', ${SERIF}` },
  { family: "Merriweather", stack: `Merriweather, ${SERIF}` },
  { family: "Lora", stack: `Lora, ${SERIF}` },
  { family: "Georgia", stack: SERIF },
  { family: "Arial", stack: "Arial, Helvetica, sans-serif" },
  { family: "Helvetica", stack: "Helvetica, Arial, sans-serif" },
  { family: "System", stack: SANS },
];

/**
 * Restrict a font family name to a safe charset (letters/digits/space/underscore/hyphen). Custom
 * font families are echoed into a `@font-face { font-family: '…' }` rule injected via
 * dangerouslySetInnerHTML — so a raw newline/`<`/`{`/`}`/`;`/quote would break out of the CSS
 * string and inject arbitrary CSS (data-exfil via url(), overlay phishing) or worse. Applied at the
 * WRITE path (upload + rename routes) so stored families are always clean, and again in the client
 * @font-face builder as defence-in-depth. Empty result → caller supplies a fallback.
 */
export function sanitizeFontFamily(raw: string): string {
  return raw
    .replace(/\s+/g, " ") // any whitespace (incl. newline/tab) → a single space first…
    .replace(/[^A-Za-z0-9 _-]/g, "") // …then drop everything outside the safe charset
    .trim()
    .slice(0, 80);
}

/** Resolve a family name to a CSS stack for preview: curated match, else the family + a sans
 *  fallback (so an uploaded custom family renders via its @font-face then falls back). */
export function fontStackFor(family: string | null | undefined): string {
  if (!family) return SANS;
  const hit = CURATED_FONTS.find((f) => f.family.toLowerCase() === family.toLowerCase());
  if (hit) return hit.stack;
  return `'${family.replace(/'/g, "")}', ${SANS}`;
}

/** Human labels for the "Type" (role) dropdown, in display order. */
export const TEXT_STYLE_ROLES: { role: TextStyleRole; label: string }[] = [
  { role: "title", label: "Title" },
  { role: "subtitle", label: "Subtitle" },
  { role: "heading", label: "Heading" },
  { role: "subheading", label: "Subheading" },
  { role: "sectionHeader", label: "Section header" },
  { role: "body", label: "Body" },
  { role: "quote", label: "Quote" },
  { role: "caption", label: "Caption" },
];

export function roleLabel(role: TextStyleRole): string {
  return TEXT_STYLE_ROLES.find((r) => r.role === role)?.label ?? role;
}

/** The default text-style rows shown before any typography is authored (matches the reference:
 *  Title 42 bold, Body 16, Quote italic, …). Seeded WITHOUT ids — `seededTextStyles()` assigns
 *  fresh uuids so React keys are stable and the payload round-trips. */
export interface TextStyleSeed {
  role: TextStyleRole;
  name: string;
  size: number;
  bold?: boolean;
  italic?: boolean;
}

export const DEFAULT_TEXT_STYLE_SEEDS: TextStyleSeed[] = [
  { role: "title", name: "Title", size: 42, bold: true },
  { role: "subtitle", name: "Subtitle", size: 28 },
  { role: "heading", name: "Heading", size: 24, bold: true },
  { role: "subheading", name: "Subheading", size: 20 },
  { role: "sectionHeader", name: "Section header", size: 18, bold: true },
  { role: "body", name: "Body", size: 16 },
  { role: "quote", name: "Quote", size: 18, italic: true },
  { role: "caption", name: "Caption", size: 13 },
];

/** Build the default text styles with fresh uuids (client-side seed for a fresh tenant). */
export function seededTextStyles(): TextStyle[] {
  return DEFAULT_TEXT_STYLE_SEEDS.map((s) => ({
    id: crypto.randomUUID(),
    name: s.name,
    role: s.role,
    fontFamily: null,
    size: s.size,
    bold: s.bold ?? false,
    italic: s.italic ?? false,
  }));
}
