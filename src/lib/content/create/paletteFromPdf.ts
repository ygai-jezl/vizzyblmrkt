import { readBrandPdf } from "@/lib/tenant/brandAsset";
import { generateTextWithFile, parseFirstJson } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { clampColors } from "./colorPalette";
import type { PaletteColor } from "@/lib/types/tenant";

/**
 * Palette-ONLY extraction from the stored brand-guidelines PDF, for the review tray. Distinct
 * from the full-kit `brand.extract_kit` (which replaces the whole brandKit on persist): this
 * returns candidate colours the operator reviews and keeps — nothing is persisted here.
 * `readBrandPdf` reconstructs the key from `tenantId`, so a crafted path can only reach the
 * caller's own tenant. Fail-soft: null on missing PDF / unavailable model / unparseable output.
 */
export async function extractPaletteFromPdf(
  tenantId: string,
  pdfPath: string,
): Promise<PaletteColor[] | null> {
  const pdf = await readBrandPdf(tenantId, pdfPath);
  if (!pdf) return null;
  const raw = await generateTextWithFile(
    renderPrompt("brand.extract_palette", {}),
    pdf.toString("base64"),
    "application/pdf",
  );
  if (!raw) return null;
  const json = parseFirstJson(raw);
  if (!json || typeof json !== "object") return null;
  const colors = clampColors((json as Record<string, unknown>).palette);
  return colors.length ? colors : null;
}
