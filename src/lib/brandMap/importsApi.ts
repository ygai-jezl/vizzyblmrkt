import { NextResponse } from "next/server";
import { z } from "zod";
import { sniffPdf } from "@/lib/tenant/brandAsset";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BRAND_MAP_RECORD_LIMITS as LIMITS } from "@/lib/types/brandMapRecords";
import { addImported, importReport } from "./importCompare";
import { placeImport, type PlaceDeps } from "./importPlace";
import { getImport, listImports, readImport, removeImport, type ImportDeps } from "./imports";
import { moveFirst } from "./recordsApi";
import { startRun, takeStep } from "./runs";

/**
 * Research from a PDF, admin APIs (BRAND_MAP_IMPORT_ENABLED): members read imports; admins
 * upload and remove them. An upload uses one research allowance and starts a run: reading
 * the file is its first step, and placing what it found takes the rest.
 */

type Deps = { db?: FirestoreLike; nowMs?: number; read?: ImportDeps };

/** POST an upload (multipart, one `file`): checked, read, and dropped; what it found is kept. */
export async function uploadImportFromRequest(ctx: TenantContext, form: FormData | null, deps: Deps = {}): Promise<Response> {
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  if (file.size > LIMITS.importBytes) return NextResponse.json({ error: "pdf_too_large" }, { status: 400 });
  const bytes = Buffer.from(await file.arrayBuffer());
  // Checked before the allowance is used: a file that isn't a PDF costs nothing.
  if (!sniffPdf(bytes)) return NextResponse.json({ error: "not_a_pdf" }, { status: 400 });
  const blocked = await moveFirst(ctx, deps);
  if (blocked) return blocked;
  const run = await startRun(ctx, "import", deps);
  if (!run.ok) return NextResponse.json({ error: run.error }, { status: run.status });
  const step = await takeStep(ctx, run.value.id, "import", deps);
  if (!step.ok) return NextResponse.json({ error: step.error }, { status: step.status });
  const r = await readImport(ctx, { fileName: file.name, bytes }, { db: deps.db, nowMs: deps.nowMs, ...deps.read });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, import: r.value, run: { id: run.value.id, stepsLeft: step.value.stepsLeft } });
}

export async function listImportsFromRequest(ctx: TenantContext, deps: Deps = {}): Promise<Response> {
  const imports = await listImports(ctx, deps);
  // A list shows each one's name, when and how much it found; the items are read one import at a time.
  return NextResponse.json({
    imports: imports.map((i) => ({ id: i.id, fileName: i.fileName, pages: i.pages, at: i.at, searches: i.searches, items: i.items.length, placed: i.placed })),
  });
}

/** GET one import with its report, worked out against the map as it is now. */
export async function importFromRequest(ctx: TenantContext, id: string, deps: Deps = {}): Promise<Response> {
  const found = await getImport(ctx, id, deps);
  if (!found) return NextResponse.json({ error: "no_import" }, { status: 404 });
  return NextResponse.json({ import: found, report: await importReport(ctx, found, deps) });
}

const PlaceBody = z.object({ runId: z.string().min(1).max(64) });

/** POST one batch of placing, as a step of the import's run: hands back whether any are left. */
export async function placeImportFromRequest(ctx: TenantContext, id: string, body: unknown, deps: Deps & { place?: Omit<PlaceDeps, "db" | "nowMs"> } = {}): Promise<Response> {
  const parsed = PlaceBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const step = await takeStep(ctx, parsed.data.runId, "import", deps);
  if (!step.ok) return NextResponse.json({ error: step.error }, { status: step.status });
  const r = await placeImport(ctx, id, { db: deps.db, nowMs: deps.nowMs, ...deps.place });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, ...r.value, stepsLeft: step.value.stepsLeft });
}

const AddBody = z.object({ items: z.array(z.string().min(1).max(40)).min(1).max(LIMITS.importItems) });

/** POST "Add ticked": the ticked items go on the map, decided; answers with the report as it now is. */
export async function addImportedFromRequest(ctx: TenantContext, id: string, body: unknown, deps: Deps = {}): Promise<Response> {
  const parsed = AddBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const blocked = await moveFirst(ctx, deps);
  if (blocked) return blocked;
  const r = await addImported(ctx, id, parsed.data.items, deps);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  const now = await getImport(ctx, id, deps);
  return NextResponse.json({ ok: true, ...r.value, ...(now ? { import: now, report: await importReport(ctx, now, deps) } : {}) });
}

export async function removeImportFromRequest(ctx: TenantContext, id: string, deps: Deps = {}): Promise<Response> {
  return (await removeImport(ctx, id, deps)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "no_import" }, { status: 404 });
}
