import { readWorkspaceAsset } from "@/lib/workspace/assetStore";
import { listBrandExemplars } from "@/lib/admin/brandKit";
import { EBOOK_IMAGE_INLINE_MAX_BYTES } from "@/lib/content/create/ebook";
import type { TenantContext } from "@/lib/tenant/types";
import { isBrandStyleRefsEnabled, MAX_STYLE_REFS, MIN_REF_RATING } from "./brandStyleLoop";

/**
 * Layer 2 of the brand-style feedback loop: fetch the tenant's best-rated on-brand
 * exemplars as STYLE reference images to hand to Nano Banana FULL, so it can match the
 * brand look by SEEING it (not just reading a text directive). Recency+rating retrieval
 * with an in-memory kind/channel filter — at low exemplar counts this avoids extra
 * composite indexes. Fail-soft: any problem returns [] and generation proceeds ungrounded.
 */
export interface RetrievedRefImage {
  base64: string;
  mimeType: string;
}

export async function retrieveExemplarImages(req: {
  ctx: TenantContext;
  /** Prefer exemplars of this kind ("social" | "ebook" | ...) when enough exist. */
  kind?: string;
  /** Prefer exemplars for this channel (social) when enough exist. */
  channel?: string;
  limit?: number;
}): Promise<RetrievedRefImage[]> {
  if (!isBrandStyleRefsEnabled()) return [];
  const limit = Math.min(req.limit ?? MAX_STYLE_REFS, MAX_STYLE_REFS);
  try {
    // Pull a slightly wider pool (already rating-desc), then prefer same kind/channel.
    const pool = await listBrandExemplars(req.ctx, { minRating: MIN_REF_RATING, limit: 12 });
    if (pool.length === 0) return [];

    const sameChannel = req.channel ? pool.filter((a) => a.channel === req.channel) : [];
    const sameKind = req.kind ? pool.filter((a) => a.kind === req.kind) : [];
    // Priority: same channel → same kind → anything. De-dupe by id, keep rating order. NOT
    // sliced to `limit` here — read down the list until `limit` READABLE refs are collected,
    // so unreadable/oversized top exemplars are backfilled by lower-priority readable ones.
    const ordered = dedupeById([...sameChannel, ...sameKind, ...pool]);

    const images: RetrievedRefImage[] = [];
    for (const a of ordered) {
      const asset = await readWorkspaceAsset(req.ctx.tenantId, a.workspaceId, a.filename).catch(
        () => null,
      );
      if (!asset) continue;
      if (asset.bytes.length > EBOOK_IMAGE_INLINE_MAX_BYTES) continue;
      images.push({ base64: asset.bytes.toString("base64"), mimeType: asset.contentType });
      if (images.length >= limit) break;
    }
    return images;
  } catch (err) {
    console.warn("[brandStyleLoop] retrieveExemplarImages failed:", err);
    return [];
  }
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * The directive appended to a generation prompt when style refs are attached, so the
 * model treats the trailing images as LOOK references — never copying their subjects,
 * text, or watermarks.
 */
export const STYLE_REF_DIRECTIVE =
  "The final image(s) attached are STYLE REFERENCES from this brand: match their palette, " +
  "lighting, mood, medium, and finishing. Do NOT copy their subjects, composition specifics, " +
  "or any text/logos/watermarks in them — only their overall visual style.";
