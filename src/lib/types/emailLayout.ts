import { z } from "zod";

/**
 * Visual email LAYOUT — the editable, block-based representation of an email node's
 * body (Create pillar email-sequence nodes). An ordered list of single-column blocks
 * that renders to email-safe HTML via src/lib/email/emailRender.ts. When an email node
 * carries a `layout`, its `body` is DERIVED from it (renderEmailLayout) and the AI copy
 * lives in the block flagged role:"copy".
 *
 * Pure + client-safe (the editor, the renderer, and generateNode all import this).
 * MUST NOT import contentPlan.ts (contentPlan imports THIS).
 */

export const MAX_EMAIL_BLOCKS = 40;
export const MAX_TEXT_HTML = 8000;
export const MAX_HEADING_HTML = 2000;
export const MAX_URL = 2000;
export const MAX_SOCIAL_LINKS = 8;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb hex colour");
const align = z.enum(["left", "center", "right"]);
const blockId = z.string().min(1).max(64);
/** Only the AI copy block carries role:"copy" (exactly one per layout). */
const role = z.enum(["copy"]).nullable().optional();

export const SOCIAL_PLATFORMS = [
  "x",
  "linkedin",
  "instagram",
  "facebook",
  "youtube",
  "tiktok",
  "website",
] as const;
const socialPlatform = z.enum(SOCIAL_PLATFORMS);

/** Per-section container BACKGROUND colour (behind the block); null = transparent. */
const sectionBg = hexColor.nullable().optional();
/** Per-section TEXT colour (text/heading blocks); null = the default ink. */
const textColor = hexColor.nullable().optional();

const TextBlock = z.object({
  id: blockId,
  kind: z.literal("text"),
  role,
  /** Tiptap-authored, sanitized HTML. May contain {{merge_tokens}} as plain text. */
  html: z.string().max(MAX_TEXT_HTML).default(""),
  color: textColor,
  sectionBg,
});
const HeadingBlock = z.object({
  id: blockId,
  kind: z.literal("heading"),
  role,
  html: z.string().max(MAX_HEADING_HTML).default(""),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  align: align.default("left"),
  color: textColor,
  sectionBg,
});
const ImageBlock = z.object({
  id: blockId,
  kind: z.literal("image"),
  role,
  src: z.string().max(MAX_URL).default(""),
  alt: z.string().max(200).default(""),
  href: z.string().max(MAX_URL).nullable().optional(),
  width: z.number().int().min(50).max(600).default(560),
  align: align.default("center"),
  sectionBg,
});
const ButtonBlock = z.object({
  id: blockId,
  kind: z.literal("button"),
  role,
  label: z.string().max(120).default("Click here"),
  href: z.string().max(MAX_URL).default(""),
  align: align.default("center"),
  bg: hexColor.default("#111111"),
  color: hexColor.default("#ffffff"),
  radius: z.number().int().min(0).max(40).default(8),
  sectionBg,
});
const DividerBlock = z.object({
  id: blockId,
  kind: z.literal("divider"),
  role,
  color: hexColor.default("#e5e5e5"),
  thickness: z.number().int().min(1).max(8).default(1),
  sectionBg,
});
const SpacerBlock = z.object({
  id: blockId,
  kind: z.literal("spacer"),
  role,
  height: z.number().int().min(4).max(120).default(24),
  sectionBg,
});
const SocialBlock = z.object({
  id: blockId,
  kind: z.literal("social"),
  role,
  align: align.default("center"),
  links: z
    .array(z.object({ platform: socialPlatform, url: z.string().max(MAX_URL) }))
    .max(MAX_SOCIAL_LINKS)
    .default([]),
  sectionBg,
});
const FooterBlock = z.object({
  id: blockId,
  kind: z.literal("footer"),
  role,
  /** Footer note above the (mock) Unsubscribe button. */
  text: z.string().max(500).default("You received this email because you signed up."),
  sectionBg,
});

export const EmailBlockSchema = z.discriminatedUnion("kind", [
  TextBlock,
  HeadingBlock,
  ImageBlock,
  ButtonBlock,
  DividerBlock,
  SpacerBlock,
  SocialBlock,
  FooterBlock,
]);
export type EmailBlock = z.infer<typeof EmailBlockSchema>;
export type EmailBlockKind = EmailBlock["kind"];

export const EmailLayoutSettingsSchema = z.object({
  bg: hexColor.default("#ffffff"),
  contentWidth: z.number().int().min(320).max(600).default(560),
});
export type EmailLayoutSettings = z.infer<typeof EmailLayoutSettingsSchema>;

export const EmailLayoutSchema = z.object({
  blocks: z.array(EmailBlockSchema).max(MAX_EMAIL_BLOCKS).default([]),
  settings: EmailLayoutSettingsSchema.optional(),
});
export type EmailLayout = z.infer<typeof EmailLayoutSchema>;

/** The block kinds a user can add, in palette order. */
export const EMAIL_BLOCK_KINDS: EmailBlockKind[] = [
  "text",
  "heading",
  "image",
  "button",
  "divider",
  "spacer",
  "social",
  "footer",
];

export function blockKindLabel(kind: EmailBlockKind): string {
  switch (kind) {
    case "text":
      return "Text";
    case "heading":
      return "Heading";
    case "image":
      return "Image";
    case "button":
      return "Button";
    case "divider":
      return "Divider";
    case "spacer":
      return "Spacer";
    case "social":
      return "Social";
    case "footer":
      return "Footer";
  }
}

/** Index of the AI copy block (role:"copy"), or -1. */
export function findCopyBlockIndex(layout: EmailLayout): number {
  return layout.blocks.findIndex((b) => b.role === "copy");
}
