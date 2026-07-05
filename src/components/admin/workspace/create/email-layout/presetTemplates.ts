import type { EmailLayout } from "@/lib/types/emailLayout";

/**
 * Built-in STARTER email layouts — ready-made block structures offered in the editor's
 * "Load template" modal (above the workspace's own saved templates). Unlike saved
 * templates these ship with the platform, are available in every workspace, and carry no
 * Firestore doc. They are adopted through the same `adoptLayout()` path as saved
 * templates (blocks re-keyed, exactly-one copy block guaranteed), so a designated
 * role:"copy" block signals which text the AI Regenerate/NL flows should rewrite.
 *
 * Pure client-safe data (imports only the type). Each `layout` MUST be a valid
 * EmailLayout — presetTemplates.test.ts parses every preset through EmailLayoutSchema.
 * Merge tokens ({{first_name}}, {{waitlist_name}}) are emitted verbatim and resolved at
 * send time (src/lib/email/mergeVars.ts). Empty image `src` is intentional — the user
 * sets a logo / generates the hero on-brand in-editor.
 */
export interface PresetEmailTemplate {
  /** Stable slug (used as the React key / analytics id). */
  id: string;
  title: string;
  description: string;
  layout: EmailLayout;
}

const ACCENT = "#4f46e5"; // indigo — matches the app accent; recolour per brand in-editor.

/**
 * Welcome & onboarding — modelled on the classic SaaS welcome email (logo → headline →
 * intro → CTA → hero → get-started tips → CTA → help → footer). The block SEQUENCE is
 * the contract; copy is placeholder.
 */
const WELCOME_ONBOARDING: EmailLayout = {
  blocks: [
    // Header — brand logo bar (empty src: the user sets their logo).
    { id: "preset_logo", kind: "image", src: "", alt: "Your logo", href: null, width: 140, align: "left" },
    // Heading — the welcome headline.
    { id: "preset_headline", kind: "heading", html: "Welcome to {{waitlist_name}}!", level: 1, align: "left" },
    // Subtitle — the intro line, and the AI copy target (Regenerate/NL rewrite this block).
    {
      id: "preset_subtitle",
      kind: "text",
      role: "copy",
      html: "<p>Hi {{first_name}}, welcome aboard. Here's everything you need to get started with {{waitlist_name}}.</p>",
    },
    // Primary CTA.
    { id: "preset_cta1", kind: "button", label: "Get started", href: "", align: "left", bg: ACCENT, color: "#ffffff", radius: 8 },
    // Hero image — full-width; generate it on-brand with ✨ in the block settings.
    { id: "preset_hero", kind: "image", src: "", alt: "Product preview", href: null, width: 560, align: "center" },
    // Smaller section header.
    { id: "preset_tips_h", kind: "heading", html: "3 tips to get started", level: 2, align: "left" },
    // Tips body.
    {
      id: "preset_tips",
      kind: "text",
      html: "<ol><li>Create your first project or import your existing work.</li><li>Set things up to automatically build, test, and ship faster.</li><li>Explore our guide for tips and best practices.</li></ol>",
    },
    // Secondary CTA.
    { id: "preset_cta2", kind: "button", label: "Go to your dashboard", href: "", align: "left", bg: ACCENT, color: "#ffffff", radius: 8 },
    // Second smaller section header.
    { id: "preset_help_h", kind: "heading", html: "Need a hand?", level: 2, align: "left" },
    // Help body.
    {
      id: "preset_help",
      kind: "text",
      html: "<p>Our team is here to help. Just reply to this email or visit our help center any time.</p>",
    },
    // Footer.
    { id: "preset_footer", kind: "footer", text: "You're receiving this because you signed up for {{waitlist_name}}." },
  ],
};

/** The starter templates offered in-editor, in display order. */
export const PRESET_EMAIL_TEMPLATES: PresetEmailTemplate[] = [
  {
    id: "welcome-onboarding",
    title: "Welcome & onboarding",
    description: "Logo, welcome headline, intro, CTA, hero image, get-started tips, a help section and a footer — a classic SaaS welcome email.",
    layout: WELCOME_ONBOARDING,
  },
];
