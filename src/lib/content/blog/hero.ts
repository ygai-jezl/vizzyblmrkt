import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { BlogHeroSchema, type BlogHero, type ContentNode } from "@/lib/types/contentPlan";
import { updateBlogHero } from "@/lib/tenant/workspaceContent";
import { storeWorkspaceImage } from "@/lib/workspace/assetStore";
import { recordImageAsset } from "@/lib/admin/brandKit";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateImageWithDeadline, generateTextWithDeadline, generateTextWithImage, type GeneratedImage } from "@/lib/agents/gemini";
import { resolveImageModel } from "@/lib/agents/modelConfig";
import { styleForImage } from "@/lib/content/imageStyle/forImage";
import { canonicalStyleId } from "@/lib/content/imageStyle/catalogue";
import { learnedDirectiveFor } from "@/lib/content/imageStyle/learning";
import { renderStyleImage, type StyleImageRequest, type StyleImageResult } from "@/lib/content/imageStyle/render/styleImage";
import { heroTitle } from "./heroTitle";

export { heroTitle };

/**
 * Every blog article gets a hero image (BLOG_HERO_ENABLED), made here:
 *  1. One run at a time: a transaction marks the hero `pending`; another request within
 *     150 s is told it's running (409 hero_running). The old image stays visible meanwhile.
 *  2. The style: the article's own pick, else the brand's blog hero style, else its default,
 *     else the Headline card.
 *  3. A template style is drawn straight away. A painted style gets a picture brief from the
 *     title, description and opening, then Nano Banana 2 at 16:9 and 2K: a 40 s try, and one
 *     more if time allows. The 1600x900 hero is the art cropped to size; the 1200x630 share
 *     card lays the title over it.
 *  4. If painting fails, the title card is drawn with the bundled fonts, which can't fail,
 *     and the hero says `fallback`. `failed` only when the files can't be stored.
 *  5. Alt text: a vision pass (8 s), else the title.
 *  6. Saved only if this run still holds the hero, so a newer run is never overwritten.
 */

export const HERO_LEASE_MS = 150_000;
const MODEL_TRY_MS = 40_000;
const ALT_MS = 8_000;
/** Kept back from the budget for the fallback, storage and the final write. */
const RESERVE_MS = 15_000;

export interface HeroDeps {
  now: () => number;
  render: (req: StyleImageRequest) => Promise<StyleImageResult | null>;
  brief: (prompt: string, timeoutMs: number) => Promise<string | null>;
  paint: (prompt: string, timeoutMs: number) => Promise<GeneratedImage | null>;
  alt: (prompt: string, image: GeneratedImage, timeoutMs: number) => Promise<string | null>;
  store: typeof storeWorkspaceImage;
  record: typeof recordImageAsset;
  update: typeof updateBlogHero;
}

const defaultDeps: HeroDeps = {
  now: () => Date.now(),
  render: renderStyleImage,
  brief: (prompt, timeoutMs) => generateTextWithDeadline(prompt, { timeoutMs }),
  paint: (prompt, timeoutMs) =>
    generateImageWithDeadline({ prompt, aspectRatio: "16:9", imageSize: "2K", model: resolveImageModel("full"), timeoutMs }),
  alt: (prompt, image, timeoutMs) =>
    Promise.race([
      generateTextWithImage(prompt, image.bytes.toString("base64"), image.mimeType),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]),
  store: storeWorkspaceImage,
  record: recordImageAsset,
  update: updateBlogHero,
};

export interface MakeHeroInput {
  ctx: TenantContext;
  tenant: Tenant | null;
  workspaceId: string;
  planId: string;
  nodeId: string;
  /** Absent = keep the article's pick; null = back to the brand's; a style id = this article's own. */
  styleOverride?: string | null;
  /** How long the whole run may take (the route: 150 s; Vizzy: what its turn has left). */
  budgetMs: number;
  /** One more painting try when the first fails and time allows (Vizzy: no). */
  retry: boolean;
  /** The brand context for the picture brief, given what was learned for the hero's style
   *  (undefined until any style has learned: then the brand's older learned look). */
  brandContextFor?: (learned: string | null | undefined) => string;
}

export type MakeHeroResult =
  | { ok: true; node: ContentNode; hero: BlogHero }
  | { ok: false; status: 400 | 404 | 409 | 502; error: "not_found" | "no_article" | "hero_running" | "store_failed" };

/** The article's opening as plain text, for the picture brief. */
function opening(markdown: string): string {
  return markdown
    .replace(/^#.*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

/** Alt text as one clean line: no quotes around it, no dashes, at most 250 characters. */
export function cleanAlt(raw: string | null, fallback: string): string {
  const line = (raw ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean)
    ?.replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+[—–-]\s+/g, ", ")
    .replace(/[—–]/g, ", ")
    .trim();
  return (line || fallback).slice(0, 250);
}

const isBlogArticle = (n: ContentNode) => n.type === "hub" && n.channel === "blog" && n.body.trim().length > 0;

export async function makeBlogHero(input: MakeHeroInput, deps: HeroDeps = defaultDeps): Promise<MakeHeroResult> {
  const { ctx, tenant, workspaceId, planId, nodeId } = input;
  const started = deps.now();
  const runId = new Date(started).toISOString();
  const left = () => input.budgetMs - (deps.now() - started);

  // 1. The lease.
  let article = true;
  const claim = await deps.update(ctx, workspaceId, planId, nodeId, (stored, node) => {
    if (!isBlogArticle(node)) {
      article = false;
      return "keep";
    }
    if (stored?.status === "pending" && stored.startedAt && started - Date.parse(stored.startedAt) < HERO_LEASE_MS) return "keep";
    return BlogHeroSchema.parse({
      ...(stored ?? {}),
      status: "pending",
      styleOverride: input.styleOverride === undefined ? (stored?.styleOverride ?? null) : input.styleOverride,
      attempts: 0,
      error: null,
      startedAt: runId,
      updatedAt: runId,
    });
  });
  if (!claim) return { ok: false, status: 404, error: "not_found" };
  if (!article) return { ok: false, status: 400, error: "no_article" };
  if (!claim.wrote) return { ok: false, status: 409, error: "hero_running" };

  const node = claim.node;
  const title = heroTitle(node);
  const footer = tenant?.rootDomain?.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;

  // 2. The style.
  const choice = styleForImage({ surface: "blogHero", tenant, override: claim.hero?.styleOverride ?? null });
  const resolved = choice.resolved;

  let made: { hero: Buffer; share: Buffer; styleId: string; status: "ready" | "fallback"; alt: string; prompt?: string; note?: BlogHero["note"]; art?: GeneratedImage } | null = null;
  let attempts = 0;
  let prompt: string | undefined;

  // 3a. A template style is drawn.
  if (resolved.engine === "template") {
    const template = resolved.id === "product_noir" ? "product_noir" : "headline_card";
    const base = { ctx, tenant, template, headline: title, footer, showLogo: true } as const;
    const hero = await deps.render({ ...base, size: "hero" });
    const share = hero ? await deps.render({ ...base, size: "share" }) : null;
    if (hero && share) made = { hero: hero.png, share: share.png, styleId: resolved.id, status: "ready", alt: title, ...(hero.note ? { note: hero.note } : {}) };
  }

  // 3b. A painted style: a picture brief, then the image model, with one retry if time allows.
  if (!made && resolved.engine === "model") {
    const direction = choice.model.direction ?? { label: resolved.label, keywords: resolved.keywords };
    prompt =
      (await deps.brief(
        renderPrompt("content.blog_hero_brief", {
          title,
          description: node.blog?.metaDescription || "(none)",
          excerpt: opening(node.body) || "(none)",
          style_label: direction.label,
          style_keywords: direction.keywords,
          brand_context: input.brandContextFor?.(learnedDirectiveFor(tenant?.imageStyle, canonicalStyleId(resolved.id))) ?? "",
        }),
        Math.min(15_000, Math.max(3_000, left() - RESERVE_MS - MODEL_TRY_MS)),
      ))?.trim() || `${title}. Visual style: ${direction.keywords}.`;
    let art: GeneratedImage | null = null;
    for (let i = 0; i < (input.retry ? 2 : 1) && !art; i++) {
      const timeout = Math.min(MODEL_TRY_MS, left() - RESERVE_MS);
      if (timeout < 5_000) break;
      attempts++;
      art = await deps.paint(prompt, timeout);
    }
    if (art) {
      const hero = await deps.render({ ctx, tenant, template: "art_overlay", size: "hero", headline: "", art: art.bytes, showHeadline: false, showLogo: false });
      const share = await deps.render({ ctx, tenant, template: "art_overlay", size: "share", headline: title, art: art.bytes, showLogo: true });
      if (hero && share) made = { hero: hero.png, share: share.png, styleId: resolved.id, status: "ready", alt: title, prompt, art };
    }
  }

  // 4. The title card: bundled fonts, nothing fetched, can't fail.
  if (!made) {
    const base = { ctx, tenant, template: "title_card", headline: title, showLogo: true } as const;
    const hero = await deps.render({ ...base, size: "hero" });
    const share = hero ? await deps.render({ ...base, size: "share" }) : null;
    if (hero && share) made = { hero: hero.png, share: share.png, styleId: "title_card", status: "fallback", alt: title, ...(prompt ? { prompt } : {}) };
  }

  // 5. Alt text for painted art.
  if (made?.art) {
    made.alt = cleanAlt(await deps.alt(renderPrompt("content.image_alt_text", { title }), made.art, ALT_MS).catch(() => null), title);
  }

  // Store both files.
  let refs: { heroRef: string; shareRef: string } | null = null;
  if (made) {
    const hero = await deps.store(ctx.tenantId, workspaceId, made.hero, "image/png");
    const share = hero.ok ? await deps.store(ctx.tenantId, workspaceId, made.share, "image/png") : null;
    if (hero.ok && share?.ok) refs = { heroRef: hero.filename, shareRef: share.filename };
  }
  let assetId: string | null = null;
  if (made && refs) {
    assetId = await deps
      .record(
        { tenantId: ctx.tenantId, region: ctx.region },
        {
          workspaceId,
          filename: refs.heroRef,
          mimeType: "image/png",
          kind: "blog_hero",
          prompt: (made.prompt ?? `${made.styleId}: ${title}`).slice(0, 1000),
          brief: title.slice(0, 1000),
          aspect: "16:9",
          style: made.styleId,
          channel: "blog",
          source: { planId, nodeId },
          parentAssetId: null,
          byteSize: made.hero.length,
        },
      )
      .then((a) => a.id)
      .catch(() => null);
  }

  // 6. Save, if this run still holds the hero.
  const now = new Date(deps.now()).toISOString();
  const saved = await deps.update(ctx, workspaceId, planId, nodeId, (stored) => {
    if (!stored || stored.startedAt !== runId) return "keep";
    if (!made || !refs) {
      // Nothing new could be stored: the last good image, if any, stays.
      return BlogHeroSchema.parse({ ...stored, status: "failed", attempts, error: made ? "store_failed" : "render_failed", updatedAt: now });
    }
    return BlogHeroSchema.parse({
      ...stored,
      status: made.status,
      styleId: made.styleId,
      heroRef: refs.heroRef,
      shareRef: refs.shareRef,
      alt: made.alt,
      prompt: made.prompt ?? null,
      attempts,
      error: null,
      forTitle: title,
      note: made.note ?? null,
      assetId,
      updatedAt: now,
    });
  });
  if (!saved) return { ok: false, status: 404, error: "not_found" };
  return { ok: true, node: saved.node, hero: saved.hero ?? claim.hero! };
}

/** A person's own words for the alt text. */
export async function setHeroAlt(
  ctx: TenantContext,
  ids: { workspaceId: string; planId: string; nodeId: string },
  alt: string,
  update: typeof updateBlogHero = updateBlogHero,
): Promise<ContentNode | null> {
  const clean = cleanAlt(alt, "");
  const r = await update(ctx, ids.workspaceId, ids.planId, ids.nodeId, (stored) =>
    stored && stored.heroRef ? BlogHeroSchema.parse({ ...stored, alt: clean, updatedAt: new Date().toISOString() }) : "keep",
  );
  return r?.wrote ? r.node : null;
}

/**
 * A person's own image as the hero: cropped to 1600x900, with a share card that lays the title
 * over it, and alt text from a vision pass. A person's upload wins over a run in progress (that
 * run's save then finds it no longer holds the hero, and keeps this one).
 */
export async function heroFromUpload(
  input: Pick<MakeHeroInput, "ctx" | "tenant" | "workspaceId" | "planId" | "nodeId">,
  upload: GeneratedImage,
  deps: HeroDeps = defaultDeps,
): Promise<MakeHeroResult> {
  const { ctx, tenant, workspaceId, planId, nodeId } = input;
  let article = true;
  const read = await deps.update(ctx, workspaceId, planId, nodeId, (_stored, node) => {
    article = isBlogArticle(node);
    return "keep";
  });
  if (!read) return { ok: false, status: 404, error: "not_found" };
  if (!article) return { ok: false, status: 400, error: "no_article" };
  const title = heroTitle(read.node);

  const hero = await deps.render({ ctx, tenant, template: "art_overlay", size: "hero", headline: "", art: upload.bytes, showHeadline: false, showLogo: false });
  const share = await deps.render({ ctx, tenant, template: "art_overlay", size: "share", headline: title, art: upload.bytes, showLogo: true });
  const heroBytes = hero?.png ?? upload.bytes;
  const heroMime = hero ? "image/png" : upload.mimeType;
  const storedHero = await deps.store(ctx.tenantId, workspaceId, heroBytes, heroMime);
  const storedShare = storedHero.ok
    ? share
      ? await deps.store(ctx.tenantId, workspaceId, share.png, "image/png")
      : storedHero
    : null;
  if (!storedHero.ok || !storedShare?.ok) return { ok: false, status: 502, error: "store_failed" };
  const alt = cleanAlt(await deps.alt(renderPrompt("content.image_alt_text", { title }), upload, ALT_MS).catch(() => null), title);
  const now = new Date(deps.now()).toISOString();
  const saved = await deps.update(ctx, workspaceId, planId, nodeId, (stored) =>
    BlogHeroSchema.parse({
      ...(stored ?? {}),
      status: "ready",
      styleId: "upload",
      heroRef: storedHero.filename,
      shareRef: storedShare.filename,
      alt,
      prompt: null,
      attempts: 0,
      error: null,
      forTitle: title,
      note: null,
      assetId: null,
      startedAt: now,
      updatedAt: now,
    }),
  );
  if (!saved?.hero) return { ok: false, status: 404, error: "not_found" };
  return { ok: true, node: saved.node, hero: saved.hero };
}
