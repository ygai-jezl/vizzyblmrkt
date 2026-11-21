import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FieldValue, RecordField } from "@/lib/types/recordField";
import { FieldInput } from "./FieldsPanel";

// One field's input, as the Fields panel and the New person form draw it before anyone types.
const AT = "2026-11-21T10:00:00.000Z";
const field = (over: Partial<RecordField>): RecordField => ({ key: "fld_aaaaaaaaaaaa", label: "Amount", type: "text", object: "person", createdAt: AT, createdBy: null, ...over });
const draw = (f: RecordField, value?: FieldValue) => renderToStaticMarkup(createElement(FieldInput, { field: f, value, team: [], onChange: () => undefined }));

describe("FieldInput", () => {
  it("shows an amount in its currency's own units, stepping by its smallest unit", () => {
    const yen = draw(field({ type: "currency", currency: "JPY" }), 1000);
    expect(yen).toContain('value="1000"');
    expect(yen).toContain('step="1"');
    const pounds = draw(field({ type: "currency", currency: "GBP" }), 1250);
    expect(pounds).toContain('value="12.50"');
    expect(pounds).toContain('step="0.01"');
    expect(draw(field({ type: "currency", currency: "KWD" }), 1250)).toContain('step="0.001"');
  });
});
