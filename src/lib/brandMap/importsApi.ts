import { NextResponse } from "next/server";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BRAND_MAP_RECORD_LIMITS as LIMITS } from "@/lib/types/brandMapRecords";
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

export async function importFromRequest(ctx: TenantContext, id: string, deps: Deps = {}): Promise<Response> {
  const found = await getImport(ctx, id, deps);
  return found ? NextResponse.json({ import: found }) : NextResponse.json({ error: "no_import" }, { status: 404 });
}

export async function removeImportFromRequest(ctx: TenantContext, id: string, deps: Deps = {}): Promise<Response> {
  return (await removeImport(ctx, id, deps)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "no_import" }, { status: 404 });
}
