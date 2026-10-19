import { fontInfo, type FontInfo } from "./sfntInfo";
import { readBrandFont, storeDerivedBrandFont } from "@/lib/tenant/brandFontStore";
import { updateBrandFont } from "@/lib/admin/brandFonts";
import type { TenantContext } from "@/lib/tenant/types";
import type { BrandFont } from "@/lib/types/brandFont";

/**
 * Brand fonts for the image renderer. The renderer (next/og) reads TTF, OTF and WOFF but not
 * WOFF2, so a WOFF2 upload is unpacked once to a TTF copy kept beside it. Uploads are also read
 * for weight and italic, so the renderer can pick the right file for a bold headline.
 */

/** A WOFF2 says how big the unpacked font will be; refuse anything silly before unpacking. */
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024;

/** Unpack a WOFF2 to TTF (or OTF). Null when it isn't a sane WOFF2 or unpacking fails. */
export async function woff2ToSfnt(bytes: Uint8Array): Promise<Buffer | null> {
  if (bytes.byteLength < 48) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0) !== 0x774f4632 /* wOF2 */) return null;
  if (v.getUint32(16) > MAX_UNPACKED_BYTES) return null;
  try {
    const { decompress } = await import("wawoff2");
    const out = await decompress(bytes);
    return out && out.byteLength > 0 ? Buffer.from(out.buffer, out.byteOffset, out.byteLength) : null;
  } catch (err) {
    console.warn("[imageStyle] woff2 unpack failed:", err);
    return null;
  }
}

export interface InspectedFont {
  info: FontInfo | null;
  derivedFilename?: string;
}

/**
 * Read an uploaded font for the renderer: its weight and italic, and for a WOFF2 a stored TTF
 * copy. Never throws; a font it can't read is still kept, it just isn't used in images.
 */
export async function inspectUploadedFont(
  tenantId: string,
  stored: { filename: string; mimeType: string },
  bytes: Buffer,
): Promise<InspectedFont> {
  if (stored.mimeType !== "font/woff2") return { info: fontInfo(bytes) };
  const sfnt = await woff2ToSfnt(bytes);
  if (!sfnt) return { info: null };
  const info = fontInfo(sfnt);
  if (!info) return { info: null };
  const derivedFilename = await storeDerivedBrandFont(tenantId, stored.filename, sfnt);
  return derivedFilename ? { info, derivedFilename } : { info };
}

/** The fields an inspection adds to a `brand_fonts` row. */
export function inspectedFields(r: InspectedFont, now = new Date().toISOString()): Partial<BrandFont> {
  return {
    ...(r.info ? { weight: r.info.weight, italic: r.info.italic } : {}),
    ...(r.derivedFilename ? { derivedFilename: r.derivedFilename } : {}),
    inspectedAt: now,
  };
}

/**
 * Back-fill a font uploaded before the image style existed: read it once and record what was
 * found (even when nothing was, so it isn't tried again). Returns the row as it now stands.
 */
export async function ensureFontInspected(ctx: TenantContext, font: BrandFont): Promise<BrandFont> {
  if (font.inspectedAt) return font;
  const file = await readBrandFont(ctx.tenantId, font.filename);
  if (!file) return font;
  const fields = inspectedFields(
    await inspectUploadedFont(ctx.tenantId, { filename: font.filename, mimeType: font.mimeType }, file.bytes),
  );
  return (await updateBrandFont(ctx, font.id, fields).catch(() => null)) ?? { ...font, ...fields };
}
