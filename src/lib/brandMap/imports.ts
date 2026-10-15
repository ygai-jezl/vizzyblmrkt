import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateTextWithFile, isGeminiConfigured } from "@/lib/agents/gemini";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { MAX_BRAND_PDF_BYTES, sniffPdf } from "@/lib/tenant/brandAsset";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BRAND_MAP_RECORD_LIMITS as LIMITS, BrandMapImportSchema, type BrandMapImport, type ImportItem } from "@/lib/types/brandMapRecords";
import { freshId, questionKey } from "./keys";
import { readBrandMap } from "./store";

/**
 * A brand's own research, from a PDF (BRAND_MAP_IMPORT_ENABLED): screenshots of Google
 * results with "People also ask" and "People also search for", an AI answer and the sites it
 * cites, or its own notes and lists of questions. ONE Gemini call reads the text and the
 * screenshots alike, a line per thing found, each with its page. The file is checked (PDF by
 * its first bytes, as the brand-guidelines upload does; 14 MB at most), read in the request
 * and dropped: only what it found is kept, as an import record.
 *
 * Code keeps the last word: a line with an address is dropped (a bare domain is allowed on a
 * CITED line), so is one with an email address or a phone number; duplicates go; at most 300
 * items a file. Everything in the file is data, never instructions.
 */

const READ_MS = 100_000;
const MAX_LINES = 400;
const MAX_SEARCHES = 20;
const MAX_THEMES = 40;
const MAX_CITED = 20;

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^["“”'*]+|["“”'*]+$/g, "").trim();
const hasAddress = (s: string) => /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|co|dev|app|uk)\/\S/i.test(s);
const hasEmail = (s: string) => /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(s);
// International numbers, North American ones, and UK-style ones starting with 0.
const hasPhone = (s: string) => /\+\d[\d\s().-]{7,}\d|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b|\b0\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/.test(s);

const KINDS = { ASK: "ask", ALSO: "also", QUESTION: "question", NOTE: "note" } as const;

export interface ImportRead {
  searches: string[];
  items: ImportItem[];
  themes: Array<{ name: string; page: number | null }>;
  cited: string[];
  /** The highest page number seen. */
  pages: number;
}

/**
 * What a related search adds to the search it was found under ("examples", "step by step"):
 * the words beyond it, when it keeps every word of the search that carries meaning. A search
 * that drops one is a different search, and adds nothing.
 */
export function addedWords(search: string, also: string): string {
  const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const base = new Set(words(search));
  const own = words(also);
  if (!base.size || ![...base].filter((w) => w.length > 2).every((w) => own.includes(w))) return "";
  return own
    .filter((w) => !base.has(w))
    .join(" ")
    .slice(0, 80);
}

/** The answer's lines, each with its page; ASK and ALSO lines carry the search before them. */
export function parseImportLines(text: string, max: number = LIMITS.importItems): ImportRead {
  const out: ImportRead = { searches: [], items: [], themes: [], cited: [], pages: 0 };
  const seen = new Set<string>();
  let search = "";
  let n = 0;
  for (const raw of (text ?? "").split(/\r?\n/).slice(0, MAX_LINES)) {
    const m = /^\s*(?:[-*•]\s*)?\**(SEARCH|ASK|ALSO|QUESTION|THEME|CITED|NOTE)\**\s*:\**\s*(.+)$/i.exec(raw);
    if (!m) continue;
    const kind = (m[1] ?? "").toUpperCase() as "SEARCH" | "ASK" | "ALSO" | "QUESTION" | "THEME" | "CITED" | "NOTE";
    const body = m[2] ?? "";
    const bar = body.lastIndexOf("|");
    const said = clean(bar >= 0 ? body.slice(0, bar) : body).slice(0, LIMITS.label);
    const pageNumber = bar >= 0 ? Number(/(\d{1,5})/.exec(body.slice(bar + 1))?.[1]) : NaN;
    const page = Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= 10_000 ? pageNumber : null;
    if (!said || hasEmail(said) || hasPhone(said)) continue;
    // A site an answer cites: its name, or its bare domain (never a link to a page).
    if (kind === "CITED" ? /https?:\/\/|\//.test(said) : hasAddress(said)) continue;
    const key = `${kind}:${questionKey(said) || said.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (page) out.pages = Math.max(out.pages, page);
    if (kind === "SEARCH") {
      search = said;
      if (out.searches.length < MAX_SEARCHES) out.searches.push(said);
    } else if (kind === "THEME") {
      if (out.themes.length < MAX_THEMES) out.themes.push({ name: said, page });
    } else if (kind === "CITED") {
      if (out.cited.length < MAX_CITED) out.cited.push(said.replace(/^www\./i, ""));
    } else if (out.items.length < max) {
      n += 1;
      out.items.push({
        id: `i${n}`,
        kind: KINDS[kind],
        text: said,
        page,
        search: kind === "ASK" || kind === "ALSO" ? search : "",
        asQuestion: "",
        subjectId: null,
        questionId: null,
        fits: true,
        adds: kind === "ALSO" && search ? addedWords(search, said) : "",
        newSubject: "",
        theme: "",
        situationId: null,
        why: "",
        tried: false,
      });
    }
  }
  return out;
}

/** A file's own name, without a path, for the record (never its contents). */
const nameOf = (name: string) =>
  (name.split(/[\\/]/).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.label) || "research.pdf";

export interface ImportDeps {
  db?: FirestoreLike;
  nowMs?: number;
  modelReady?: () => boolean;
  /** Read the PDF: the prompt and the file as base64. */
  read?: (prompt: string, base64: string) => Promise<string | null>;
}

export type ImportResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** Read one PDF and keep what it found as an import record. The file itself is never kept. */
export async function readImport(ctx: TenantContext, input: { fileName: string; bytes: Buffer }, deps: ImportDeps = {}): Promise<ImportResult<BrandMapImport>> {
  if (!(deps.modelReady ?? isGeminiConfigured)()) return { ok: false, status: 503, error: "no_model" };
  if (input.bytes.length > Math.min(LIMITS.importBytes, MAX_BRAND_PDF_BYTES)) return { ok: false, status: 400, error: "pdf_too_large" };
  if (!sniffPdf(input.bytes)) return { ok: false, status: 400, error: "not_a_pdf" };
  const store = brandMapRecords(ctx, deps.db);
  if ((await store.count("imp").catch(() => 0)) >= LIMITS.imports) return { ok: false, status: 409, error: "too_many_imports" };

  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  const identity = read?.state === "ok" ? read.map.identity : null;
  const prompt = renderPrompt("brand.map_import", {
    brand_name: (identity?.name ?? "").replace(/["\n]/g, " ").slice(0, 120) || "(not named)",
    category: identity?.category ? `, in the category "${identity.category.replace(/["\n]/g, " ").slice(0, 80)}"` : "",
    max: MAX_LINES,
  });
  const text = await (deps.read ?? ((p: string, b64: string) => generateTextWithFile(p, b64, "application/pdf", { timeoutMs: READ_MS })))(prompt, input.bytes.toString("base64")).catch(
    () => null,
  );
  const found = parseImportLines(text ?? "");
  if (!found.items.length && !found.searches.length && !found.themes.length) return { ok: false, status: 502, error: "import_failed" };

  const record = BrandMapImportSchema.parse({
    id: freshId("imp"),
    tenantId: ctx.tenantId,
    fileName: nameOf(input.fileName),
    pages: found.pages,
    at: new Date(deps.nowMs ?? Date.now()).toISOString(),
    by: ctx.userId ?? null,
    searches: found.searches,
    items: found.items,
    themes: found.themes,
    cited: found.cited,
    placed: false,
  });
  const { id, tenantId: _t, ...data } = record;
  void _t;
  await store.create("imp", id, data);
  return { ok: true, value: record };
}

const parseImport = (raw: unknown): BrandMapImport | null => {
  const r = BrandMapImportSchema.safeParse(raw);
  return r.success ? r.data : null;
};

/** A brand's imports, newest first. */
export async function listImports(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<BrandMapImport[]> {
  const rows = await brandMapRecords(ctx, deps.db).find("imp", { orderBy: [["at", "desc"]], limit: LIMITS.imports });
  return rows.flatMap((r) => parseImport(r) ?? []);
}

export async function getImport(ctx: TenantContext, id: string, deps: { db?: FirestoreLike } = {}): Promise<BrandMapImport | null> {
  return parseImport(await brandMapRecords(ctx, deps.db).get("imp", id));
}

/** Remove an import's record. What a person added from it stays on the map. */
export async function removeImport(ctx: TenantContext, id: string, deps: { db?: FirestoreLike } = {}): Promise<boolean> {
  const store = brandMapRecords(ctx, deps.db);
  if (!(await store.get("imp", id))) return false;
  await store.remove("imp", id);
  return true;
}
