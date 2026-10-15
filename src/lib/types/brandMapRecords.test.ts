import { describe, expect, it } from "vitest";
import {
  BRAND_MAP_RECORD_LIMITS,
  BrandMapImportSchema,
  BrandMapQuestionRecordSchema,
  BrandMapSituationSchema,
  BrandMapSubjectRecordSchema,
} from "./brandMapRecords";

describe("the brand map's records", () => {
  it("fills what a subject leaves out, and starts it ungrouped and decided", () => {
    const s = BrandMapSubjectRecordSchema.parse({ id: "sub_aaaaaaaa", tenantId: "ten_A", name: "Share of voice", nameKey: "share of voice" });
    expect(s).toMatchObject({
      groupId: null,
      status: "decided",
      from: "person",
      home: null,
      counts: { questions: 0, answered: 0, drafted: 0, planned: 0, open: 0 },
      answeredShare: 0,
      answeredIds: [],
      mergedInto: null,
      rev: 0,
    });
  });

  it("keeps every name and question to one line, and every id to its kind", () => {
    expect(BrandMapSubjectRecordSchema.safeParse({ id: "sub_aaaaaaaa", tenantId: "t", name: "Two\nlines", nameKey: "x" }).success).toBe(false);
    expect(BrandMapSubjectRecordSchema.safeParse({ id: "q_aaaaaaaa", tenantId: "t", name: "x", nameKey: "x" }).success).toBe(false);
    expect(BrandMapQuestionRecordSchema.safeParse({ id: "q_aaaaaaaa", tenantId: "t", subjectId: "sub_aaaaaaaa", text: "What is it?", textKey: "what is it" }).success).toBe(true);
  });

  it("reads a status it doesn't know (from a later build) as dismissed, so it never reaches an article", () => {
    const s = BrandMapSubjectRecordSchema.parse({ id: "sub_aaaaaaaa", tenantId: "t", name: "x", nameKey: "x", status: "archived" });
    expect(s.status).toBe("dismissed");
  });

  it("keeps a buying situation's W, side and backing, and treats a strange W as why", () => {
    const sit = BrandMapSituationSchema.parse({
      id: "sit_aaaaaaaa",
      tenantId: "t",
      text: "Our clicks from Google are falling, but our rankings aren't",
      textKey: "our clicks from google are falling but our rankings aren t",
      w: "when",
      wText: "after the monthly traffic report",
      side: "professional",
      backedBy: [{ kind: "page", label: "Home page", url: "https://acme.example/" }],
      seen: [{ title: "Why is my CTR dropping?", domain: "reddit.com" }],
    });
    expect(sit).toMatchObject({ w: "when", side: "professional", backed: true, focus: false, status: "decided" });
    expect(BrandMapSituationSchema.parse({ id: "sit_aaaaaaaa", tenantId: "t", text: "x", textKey: "x", w: "how" }).w).toBe("why");
  });

  it("drops an import item that no longer parses, and keeps the rest", () => {
    const imp = BrandMapImportSchema.parse({
      id: "imp_aaaaaaaa",
      tenantId: "t",
      fileName: "Research.pdf",
      at: "2026-10-15T09:00:00.000Z",
      items: [
        { id: "i1", kind: "ask", text: "Is SEO still worth it in 2026?", page: 3 },
        { id: "i2", kind: "a-kind-from-later", text: "x" },
        { id: "i3", kind: "also", text: "AI search optimization tools", page: 4, adds: "tools" },
      ],
    });
    expect(imp.items.map((i) => i.id)).toEqual(["i1", "i3"]);
    expect(imp.items[0]).toMatchObject({ page: 3, fits: true, subjectId: null });
  });

  it("are safety limits, far above any count we'd suggest", () => {
    expect(BRAND_MAP_RECORD_LIMITS.subjects).toBeGreaterThanOrEqual(5_000);
    expect(BRAND_MAP_RECORD_LIMITS.questionsPerSubject).toBeGreaterThan(20);
  });
});
