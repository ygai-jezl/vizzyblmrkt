import type { LoopKind } from "./registry";

/**
 * The kinds that make images, which follow IMAGE_STYLE_VERSIONS_ENABLED alone (decision 22 of the
 * plan for learning loops steps 4 and 5). Kept apart from ./read.ts so writers in the tenant layer
 * can tell an image's stamp from a words' stamp without loading the reader. Pure.
 */
export const IMAGE_KINDS = [
  "post_image",
  "blog_hero",
  "ebook_image",
  "email_block_image",
  "email_hero",
  "customize_image",
  "carousel",
] as const satisfies readonly LoopKind[];
export type ImageKind = (typeof IMAGE_KINDS)[number];

export const isImageKind = (kind: LoopKind | string): kind is ImageKind => (IMAGE_KINDS as readonly string[]).includes(kind);
