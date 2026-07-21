/**
 * Single source of truth for the GENERATIVE AI model ids the Next app uses.
 *
 * Models change often, so NO other module may hard-code a model name — import
 * from here. Each model is env-overridable (set the env var to change the deployed
 * model with zero code change) and falls back to a default literal defined ONCE
 * below. The `DEFAULT_*` literals are exported too so a script that loads its env
 * at runtime (scripts/translate-messages.ts) can re-resolve `process.env` AFTER
 * loading .env.local without duplicating the literal — see that script.
 *
 * NOTE: the EMBEDDING model is deliberately NOT here. `text-embedding-005` is
 * PINNED in src/lib/types/knowledgeBase.ts (EMBEDDING_MODEL + EMBEDDING_DIM)
 * because it is coupled to the Firestore vector-index dimension and to every
 * already-embedded document — changing it is a re-embedding migration, not a
 * config flip. Keep generative (changeable) and embedding (pinned) models separate.
 */

/** Text / multimodal generation: Agent 1 market-intel, Agent 3 creative, the
 *  compiler, templatize/deconstruct, the Create architect, and i18n translation. */
export const DEFAULT_TEXT_MODEL = "gemini-3.6-flash";
export const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL ?? DEFAULT_TEXT_MODEL;

/** Image generation (Imagen) — Agent 3 hero images. */
export const DEFAULT_IMAGE_MODEL = "imagen-4.0-generate-001";
export const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;

/** Carousel slide images (Gemini "Nano Banana" image model — text-rich slides via
 *  generateContent + IMAGE modality; distinct from Imagen hero images above). */
export const DEFAULT_CAROUSEL_IMAGE_MODEL = "gemini-2.5-flash-image";
export const CAROUSEL_IMAGE_MODEL =
  process.env.GEMINI_CAROUSEL_IMAGE_MODEL ?? DEFAULT_CAROUSEL_IMAGE_MODEL;

/** Email-layout block images + social post images — Gemini "Nano Banana 2" lite image
 *  model (gemini-3.1-flash-lite-image) via generateContent + IMAGE modality. Env-
 *  overridable per the model-hardcoding policy. */
export const DEFAULT_BLOCK_IMAGE_MODEL = "gemini-3.1-flash-lite-image";
export const BLOCK_IMAGE_MODEL =
  process.env.GEMINI_BLOCK_IMAGE_MODEL ?? DEFAULT_BLOCK_IMAGE_MODEL;

/** eBook illustration images (Create eBook studio) — Gemini "Nano Banana 2" FULL image
 *  model (gemini-3.1-flash-image, NOT the -lite variant): the full model is edit-capable
 *  (image-in→image-out iteration) and supports the extreme 1:4 aspect ratio the eBook
 *  page layout uses. Env-overridable per the model-hardcoding policy. */
export const DEFAULT_EBOOK_IMAGE_MODEL = "gemini-3.1-flash-image";
export const EBOOK_IMAGE_MODEL =
  process.env.GEMINI_EBOOK_IMAGE_MODEL ?? DEFAULT_EBOOK_IMAGE_MODEL;

/** Gemini Live voice conversation (post-signup waitlist voice chat). Native-audio
 *  model — see liveConversation.ts for the cascaded-model language-code caveat. */
export const DEFAULT_LIVE_MODEL = "gemini-3.1-flash-live-preview";
export const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL ?? DEFAULT_LIVE_MODEL;

/**
 * Resolve an operator-selected image-model SLUG (see lib/content/create/imageModels.ts) to the
 * actual, env-overridable model id. Keeps model selection env-configurable and off the client:
 * the UI/routes pass a slug, the server maps it here. "full" → the edit-capable Nano Banana 2
 * FULL model; anything else → the lite block model. Callers should validate the slug (zod) first;
 * an unknown slug falls back to the lite model rather than throwing.
 */
export function resolveImageModel(slug: string): string {
  return slug === "full" ? EBOOK_IMAGE_MODEL : BLOCK_IMAGE_MODEL;
}
