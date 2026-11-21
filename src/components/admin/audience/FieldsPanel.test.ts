import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FieldValue, RecordField } from "@/lib/types/recordField";
import { FieldInput, FieldsPanel } from "./FieldsPanel";

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

  it("shows an archived option the value still holds, ticked, so it can be taken off", () => {
    const options = [
      { id: "opt_00000001", label: "Analytics" },
      { id: "opt_00000002", label: "Exports", archivedAt: AT },
      { id: "opt_00000003", label: "Legacy", archivedAt: AT },
    ];
    const html = draw(field({ type: "multi_select", label: "Interests", options }), ["opt_00000001", "opt_00000002"]);
    expect(html).toContain("Exports (no longer in use)");
    expect(html).not.toContain("Legacy");
    const select = draw(field({ type: "select", label: "Plan", options }), "opt_00000003");
    expect(select).toContain("Legacy (no longer in use)");
    expect(select).not.toContain("Exports");
  });
});

describe("FieldsPanel", () => {
  const panel = (canEdit: boolean) => renderToStaticMarkup(createElement(FieldsPanel, { object: "person", recordId: "ct_1", initialValues: {}, canEdit }));

  it("offers admins Manage fields, and members only See all fields, since Data model is read only for them", () => {
    expect(panel(true)).toContain("Manage fields");
    expect(panel(false)).toContain("See all fields");
    expect(panel(false)).not.toContain("Manage fields");
  });
});
