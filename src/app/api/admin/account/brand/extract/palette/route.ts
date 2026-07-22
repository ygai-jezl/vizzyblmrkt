import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isBrandColorsEnabled } from "@/lib/content/brandKit";
import { extractPaletteFromPdf } from "@/lib/content/create/paletteFromPdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Schema = z.object({
  pdfPath: z.string().min(1).max(300),
  pdfName: z.string().max(300).nullable().optional(),
});

/**
 * Extract ONLY the colour palette from the stored brand PDF and return it as review-tray
 * CANDIDATES (never persisted — the operator keeps/removes, then Saves the brand kit).
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBrandColorsEnabled()) return NextResponse.json({ error: "not_enabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  // readBrandPdf (inside extractPaletteFromPdf) reconstructs the key from ctx.tenantId — a
  // crafted path can only ever reach the caller's OWN tenant's files.
  const candidates = await extractPaletteFromPdf(ctx.tenantId, parsed.data.pdfPath);
  if (!candidates) return NextResponse.json({ error: "extraction_failed" }, { status: 502 });

  return NextResponse.json({
    candidates,
    label: parsed.data.pdfName?.trim() || "Brand PDF",
    source: "pdf",
  });
}
