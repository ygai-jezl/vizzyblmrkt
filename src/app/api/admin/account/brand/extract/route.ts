import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { updateTenantConfig, withPreservedLearnedStyle } from "@/lib/tenant/control";
import { getTenantById } from "@/lib/tenant";
import { readBrandPdf } from "@/lib/tenant/brandAsset";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateTextWithFile, parseFirstJson } from "@/lib/agents/gemini";
import { BrandKitSchema } from "@/lib/types/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ExtractSchema = z.object({
  pdfPath: z.string().min(1).max(300),
  pdfName: z.string().max(300).nullable().optional(),
});

/** Read the stored brand PDF, AI-extract a structured kit, persist it on the tenant. */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = ExtractSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  // readBrandPdf reconstructs the key from ctx.tenantId — a crafted path can only
  // ever reach the caller's OWN tenant's files (and the filename is regex-validated).
  const pdf = await readBrandPdf(ctx.tenantId, parsed.data.pdfPath);
  if (!pdf) return NextResponse.json({ error: "pdf_not_found" }, { status: 404 });

  const raw = await generateTextWithFile(
    renderPrompt("brand.extract_kit", {}),
    pdf.toString("base64"),
    "application/pdf",
  );
  const json = raw ? parseFirstJson(raw) : null;
  if (!json) return NextResponse.json({ error: "extraction_failed" }, { status: 502 });

  // Validate the extracted fields (nulls tolerated), then stamp the source + time.
  const kit = BrandKitSchema.safeParse({
    ...(json as Record<string, unknown>),
    pdfPath: parsed.data.pdfPath,
    pdfName: parsed.data.pdfName ?? null,
    extractedAt: new Date().toISOString(),
  });
  if (!kit.success) return NextResponse.json({ error: "extraction_invalid" }, { status: 502 });

  // Re-extraction REPLACES the whole brandKit — carry the feedback-loop learned style
  // forward so it isn't wiped (it lives on brandKit; the extract model never returns it).
  const existing = await getTenantById(ctx.tenantId);
  const merged = withPreservedLearnedStyle(kit.data, existing?.brandKit);
  // Named palette GROUPS (website / AI theme / logo, curated in the Colours card) are NOT
  // produced by the full-kit extract prompt — carry them forward so a PDF re-extract (which
  // replaces the whole brandKit map) never silently wipes the operator's kept palettes.
  if (existing?.brandKit?.palettes?.length) merged.palettes = existing.brandKit.palettes;
  await updateTenantConfig(ctx.tenantId, { brandKit: merged });
  return NextResponse.json({ brandKit: merged });
}
