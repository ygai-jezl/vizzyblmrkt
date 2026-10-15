import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { addedWords, getImport, listImports, parseImportLines, readImport, removeImport } from "./imports";
import { uploadImportFromRequest } from "./importsApi";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const PDF = Buffer.from("%PDF-1.7\n% a made-up research file\n");

// Made-up research: a search, its "People also ask" and "People also search for", an AI answer's headings and sources.
const ANSWER = [
  "SEARCH: how to track brand mentions in ai answers | 1",
  "ASK: How do I see what ChatGPT says about my brand? | 1",
  "ASK: Can I get alerts when an AI answer changes? | p. 2",
  "ALSO: how to track brand mentions in ai answers free | 2",
  "ALSO: how to track brand mentions in ai answers step by step | 2",
  "ALSO: ai brand monitoring tools | 2",
  "THEME: Pick the prompts that matter | 3",
  "CITED: example-blog.co.uk | 3",
  "CITED: Example Developers | 3",
  "CITED: https://example.com/guide | 3",
  "QUESTION: Which engines should we watch first? | 4",
  "NOTE: Most answers cite the same five sites | 4",
  "QUESTION: Call Sam on 020 7946 0958 about it? | 4",
  "QUESTION: Email sam@example.com for the list? | 4",
  "ASK: Read https://example.com/x first? | 1",
  "ASK: How do I see what ChatGPT says about my brand? | 1",
  "Here is what I found:",
].join("\n");

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_IMPORT_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("reading a PDF's lines", () => {
  it("keeps each thing once with its page, the search it was under, and what a related search adds", () => {
    const read = parseImportLines(ANSWER);
    expect(read.searches).toEqual(["how to track brand mentions in ai answers"]);
    expect(read.items.map((i) => [i.kind, i.text, i.page, i.search, i.adds])).toEqual([
      ["ask", "How do I see what ChatGPT says about my brand?", 1, "how to track brand mentions in ai answers", ""],
      ["ask", "Can I get alerts when an AI answer changes?", 2, "how to track brand mentions in ai answers", ""],
      ["also", "how to track brand mentions in ai answers free", 2, "how to track brand mentions in ai answers", "free"],
      ["also", "how to track brand mentions in ai answers step by step", 2, "how to track brand mentions in ai answers", "step by step"],
      // A different search: it adds nothing.
      ["also", "ai brand monitoring tools", 2, "how to track brand mentions in ai answers", ""],
      ["question", "Which engines should we watch first?", 4, "", ""],
      ["note", "Most answers cite the same five sites", 4, "", ""],
    ]);
    expect(read.themes).toEqual([{ name: "Pick the prompts that matter", page: 3 }]);
    // A name or bare domain, never a link.
    expect(read.cited).toEqual(["example-blog.co.uk", "Example Developers"]);
    expect(read.pages).toBe(4);
    expect(parseImportLines(Array.from({ length: 20 }, (_, i) => `QUESTION: Question number ${i}? | 1`).join("\n"), 5).items).toHaveLength(5);
  });

  it("says what a related search adds only when it keeps the search's words", () => {
    expect(addedWords("best crm for startups", "best crm for startups reddit")).toBe("reddit");
    expect(addedWords("best crm for startups", "crm pricing")).toBe("");
    expect(addedWords("", "anything")).toBe("");
  });
});

describe("research from a PDF", () => {
  it("reads a PDF, keeps what it found with the file's name, and never the file", async () => {
    const db = new FakeFirestore();
    const read = vi.fn(async (_prompt: string, _b64: string) => ANSWER);
    const r = await readImport(ctx, { fileName: "C:\\Users\\me\\Research notes.pdf", bytes: PDF }, { db, nowMs: NOW, modelReady: () => true, read });
    expect(r).toMatchObject({ ok: true, value: { fileName: "Research notes.pdf", pages: 4, by: "u1", placed: false, cited: ["example-blog.co.uk", "Example Developers"] } });
    expect(read.mock.calls[0]![0]).toContain("Never copy a person's name, email address or phone number");
    expect(read.mock.calls[0]![1]).toBe(PDF.toString("base64"));
    const id = r.ok ? r.value.id : "";
    const kept = await brandMapRecords(ctx, db).get("imp", id);
    expect(JSON.stringify(kept)).not.toContain("JVBER"); // the file's base64 is nowhere in it
    expect((await getImport(ctx, id, { db }))?.items).toHaveLength(7);
    expect((await listImports(ctx, { db })).map((i) => i.id)).toEqual([id]);
    expect(await removeImport(ctx, id, { db })).toBe(true);
    expect(await getImport(ctx, id, { db })).toBeNull();
  });

  it("refuses anything but a PDF by its first bytes, and says when nothing could be read", async () => {
    const db = new FakeFirestore();
    const read = vi.fn(async () => ANSWER);
    expect(await readImport(ctx, { fileName: "x.pdf", bytes: Buffer.from("<html>not a pdf</html>") }, { db, modelReady: () => true, read })).toEqual({ ok: false, status: 400, error: "not_a_pdf" });
    expect(await readImport(ctx, { fileName: "x.pdf", bytes: PDF }, { db, modelReady: () => true, read: async () => "Nothing here." })).toEqual({ ok: false, status: 502, error: "import_failed" });
    expect(await readImport(ctx, { fileName: "x.pdf", bytes: PDF }, { db, modelReady: () => false })).toEqual({ ok: false, status: 503, error: "no_model" });
    expect(read).not.toHaveBeenCalled();
  });

  it("uploads through one research allowance, and refuses a file over 14 MB before reading it", async () => {
    const db = new FakeFirestore();
    const form = new FormData();
    form.set("file", new File([PDF], "notes.pdf", { type: "application/pdf" }));
    const res = await uploadImportFromRequest(ctx, form, { db, nowMs: NOW, read: { modelReady: () => true, read: async () => ANSWER } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { import: { fileName: string }; run: { id: string; stepsLeft: number } };
    expect(body.import.fileName).toBe("notes.pdf");
    expect(body.run.stepsLeft).toBe(11);

    const big = new FormData();
    big.set("file", new File([Buffer.alloc(14 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" }));
    const refused = await uploadImportFromRequest(ctx, big, { db });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "pdf_too_large" });
  });

  it("refuses a file that isn't a PDF before using a research allowance", async () => {
    const db = new FakeFirestore();
    const form = new FormData();
    // Named and typed as a PDF; its first bytes say otherwise.
    form.set("file", new File([Buffer.from("PK\u0003\u0004 a zip")], "notes.pdf", { type: "application/pdf" }));
    const res = await uploadImportFromRequest(ctx, form, { db, nowMs: NOW });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "not_a_pdf" });
    expect(await brandMapRecords(ctx, db).find("run")).toEqual([]);
  });
});
