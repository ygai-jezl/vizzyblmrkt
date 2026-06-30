/**
 * Template TAXONOMIES — separate from the 26 Content Matrix topics:
 *  - CATEGORY = content INTENT (the "4 E's"). Fixed set; a templatized idea gets one.
 *  - GROUP = a structural/modular block (Newsletter/Podcast, Pre-Hub CTA, …). Free-form
 *    + user-creatable; SEED_TEMPLATE_GROUPS only seed the combobox suggestions.
 *
 * Pure + dependency-free (safe in the client bundle). The Zod enum that VALIDATES a
 * category lives in src/lib/types/template.ts and MUST stay in sync with the ids here
 * (a unit test asserts parity).
 */
export interface TemplateCategory {
  id: string;
  label: string;
  /** One-line hint shown in the UI / fed to the model. */
  hint: string;
}

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  { id: "educate", label: "Educate", hint: "Teach a principle, framework, or how-to." },
  { id: "empathise", label: "Empathise", hint: "Name a shared struggle or feeling." },
  { id: "entertain", label: "Entertain", hint: "Amuse, surprise, or tell a story." },
  { id: "challenge", label: "Challenge", hint: "Poke a belief or push a contrarian take." },
];

const CATEGORY_IDS = new Set(TEMPLATE_CATEGORIES.map((c) => c.id));

export const DEFAULT_TEMPLATE_CATEGORY = "educate";

export function isTemplateCategory(id: string): boolean {
  return CATEGORY_IDS.has(id);
}

export function templateCategoryLabel(id: string): string {
  return TEMPLATE_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

/** Seed structural GROUPS (Content OS modular blocks) — combobox suggestions only;
 *  a workspace accumulates its own custom groups over time. */
export const SEED_TEMPLATE_GROUPS = [
  "Newsletter/Podcast",
  "Pre-Hub CTA",
  "Post-Hub CTA",
  "LinkedIn Spoke",
  "Twitter Thread",
  "Uncategorised",
];
