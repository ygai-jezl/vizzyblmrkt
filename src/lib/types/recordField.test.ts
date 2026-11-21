import { describe, expect, it } from "vitest";
import { jsonBytes } from "@/lib/ontology/events";
import { SETTINGS_LIMITS } from "./settingsVersion";
import {
  amountToMinor,
  checkFieldValue,
  currencyDigits,
  FIELD_LIMITS,
  FIELD_TYPES,
  fieldListProblems,
  FieldListSchema,
  isCalendarDay,
  minorToAmount,
  optionIdsOf,
  optionsForValue,
  RecordFieldSchema,
  sameFieldValue,
  type RecordField,
} from "./recordField";

const AT = "2026-11-21T10:00:00.000Z";
const opt = (n: number, archived = false) => ({ id: `opt_${String(n).padStart(8, "0")}`, label: `Option ${n}`, ...(archived ? { archivedAt: AT } : {}) });
const field = (over: Partial<RecordField> = {}): RecordField => ({
  key: "fld_aaaaaaaaaaaa",
  label: "Plan",
  type: "text",
  object: "person",
  createdAt: AT,
  createdBy: "u_admin",
  ...over,
});
const select = field({ type: "select", options: [opt(1), opt(2), opt(3, true)] });

describe("a field", () => {
  it("takes every one of the twelve types", () => {
    expect(FIELD_TYPES).toHaveLength(12);
    for (const type of FIELD_TYPES) {
      const f = field({
        type,
        ...(type === "select" || type === "multi_select" || type === "status" ? { options: [opt(1)] } : {}),
        ...(type === "currency" ? { currency: "GBP" } : {}),
      });
      expect(RecordFieldSchema.safeParse(f).success, type).toBe(true);
    }
  });

  it("keeps options to the types that pick, and a currency code to currency", () => {
    expect(RecordFieldSchema.safeParse(field({ type: "select" })).success).toBe(false);
    expect(RecordFieldSchema.safeParse(field({ type: "text", options: [opt(1)] })).success).toBe(false);
    expect(RecordFieldSchema.safeParse(field({ type: "currency" })).success).toBe(false);
    expect(RecordFieldSchema.safeParse(field({ type: "currency", currency: "gbp" })).success).toBe(false);
    expect(RecordFieldSchema.safeParse(field({ type: "number", currency: "GBP" })).success).toBe(false);
    expect(RecordFieldSchema.safeParse(field({ type: "select", options: [opt(1), opt(1)] })).success).toBe(false);
  });

  it("has an id that fits a dotted path, a label up to 60 characters and user ids only", () => {
    expect(RecordFieldSchema.safeParse(field({ key: "fld_ABC" })).success).toBe(false);
    expect(RecordFieldSchema.safeParse(field({ key: "fields.x" })).success).toBe(false);
    expect(RecordFieldSchema.safeParse(field({ label: "x".repeat(61) })).success).toBe(false);
    expect(RecordFieldSchema.safeParse(field({ label: "   " })).success).toBe(false);
    expect(RecordFieldSchema.safeParse(field({ createdBy: "admin@example.com" })).success).toBe(false);
    expect(RecordFieldSchema.parse(field({ label: "  Plan  " })).label).toBe("Plan");
  });
});

describe("values", () => {
  const ok = (f: Pick<RecordField, "type" | "options" | "currency">, raw: unknown) => {
    const r = checkFieldValue(f, raw);
    return r.ok ? r.value : "BAD";
  };

  it("null clears any type", () => {
    for (const type of FIELD_TYPES) expect(ok({ type, options: [opt(1)] }, null)).toBeNull();
  });

  it("text is trimmed, up to 2000 characters, and empty clears", () => {
    expect(ok({ type: "text" }, "  hi  ")).toBe("hi");
    expect(ok({ type: "text" }, "   ")).toBeNull();
    expect(ok({ type: "text" }, "x".repeat(FIELD_LIMITS.textChars))).toHaveLength(2000);
    expect(ok({ type: "text" }, "x".repeat(FIELD_LIMITS.textChars + 1))).toBe("BAD");
    expect(ok({ type: "text" }, 5)).toBe("BAD");
  });

  it("number is finite, and currency is whole minor units", () => {
    expect(ok({ type: "number" }, 1.5)).toBe(1.5);
    expect(ok({ type: "number" }, Number.POSITIVE_INFINITY)).toBe("BAD");
    expect(ok({ type: "number" }, "3")).toBe("BAD");
    expect(ok({ type: "currency", currency: "GBP" }, 1250)).toBe(1250);
    expect(ok({ type: "currency", currency: "GBP" }, 12.5)).toBe("BAD");
  });

  it("a currency's minor units follow its own digits: two for GBP, none for JPY, three for KWD", () => {
    expect(currencyDigits("GBP")).toBe(2);
    expect(currencyDigits("JPY")).toBe(0);
    expect(currencyDigits("KWD")).toBe(3);
    expect(currencyDigits(undefined)).toBe(2);
    expect(currencyDigits("not a code")).toBe(2);
    expect(minorToAmount(1250, "GBP")).toBe("12.50");
    expect(minorToAmount(1000, "JPY")).toBe("1000");
    expect(minorToAmount(1250, "KWD")).toBe("1.250");
    expect(amountToMinor("12.5", "GBP")).toBe(1250);
    expect(amountToMinor("1000", "JPY")).toBe(1000);
    expect(amountToMinor("1.25", "KWD")).toBe(1250);
    expect(amountToMinor("lots", "GBP")).toBeNaN();
  });

  it("a date is a real calendar day with no time", () => {
    expect(ok({ type: "date" }, "2027-03-01")).toBe("2027-03-01");
    expect(ok({ type: "date" }, "2027-02-30")).toBe("BAD");
    expect(ok({ type: "date" }, "2027-03-01T00:00:00.000Z")).toBe("BAD");
    expect(isCalendarDay("2028-02-29")).toBe(true);
  });

  it("an option value must be live, unless the record already holds it", () => {
    const f = field({ type: "multi_select", options: [opt(1), opt(2, true)] });
    expect(checkFieldValue(f, ["opt_00000001", "opt_00000002"])).toMatchObject({ ok: false, reason: "option" });
    expect(checkFieldValue(f, ["opt_00000001", "opt_00000002"], new Set(["opt_00000002"]))).toEqual({ ok: true, value: ["opt_00000001", "opt_00000002"] });
    const select = field({ type: "select", options: [opt(1), opt(2, true)] });
    expect(checkFieldValue(select, "opt_00000002")).toMatchObject({ ok: false });
    expect(checkFieldValue(select, "opt_00000002", new Set(["opt_00000002"]))).toEqual({ ok: true, value: "opt_00000002" });
    expect(optionsForValue(select, "opt_00000002").map((o) => o.id)).toEqual(["opt_00000001", "opt_00000002"]);
    expect(optionsForValue(select, "opt_00000001").map((o) => o.id)).toEqual(["opt_00000001"]);
    expect(optionIdsOf(["opt_00000001", 3])).toEqual(["opt_00000001"]);
  });

  it("a checkbox is true or false", () => {
    expect(ok({ type: "checkbox" }, true)).toBe(true);
    expect(ok({ type: "checkbox" }, false)).toBe(false);
    expect(ok({ type: "checkbox" }, "yes")).toBe("BAD");
  });

  it("select and status take one option in use", () => {
    expect(ok(select, "opt_00000001")).toBe("opt_00000001");
    expect(ok(select, "opt_00000003")).toBe("BAD");
    expect(ok(select, "opt_99999999")).toBe("BAD");
    expect(ok({ ...select, type: "status" }, "opt_00000002")).toBe("opt_00000002");
  });

  it("multi select takes up to 20 distinct options in use", () => {
    const many = field({ type: "multi_select", options: Array.from({ length: 30 }, (_, i) => opt(i)) });
    expect(ok(many, ["opt_00000001", "opt_00000001", "opt_00000002"])).toEqual(["opt_00000001", "opt_00000002"]);
    expect(ok(many, [])).toBeNull();
    expect(ok(many, many.options!.slice(0, 21).map((o) => o.id))).toBe("BAD");
    expect(ok({ ...select, type: "multi_select" }, ["opt_00000003"])).toBe("BAD");
    expect(ok(many, "opt_00000001")).toBe("BAD");
  });

  it("email is lowercased and checked, phone trimmed, link http or https", () => {
    expect(ok({ type: "email" }, " Sam@Example.com ")).toBe("sam@example.com");
    expect(ok({ type: "email" }, "not an email")).toBe("BAD");
    expect(ok({ type: "phone" }, " +44 7700 900123 ")).toBe("+44 7700 900123");
    expect(ok({ type: "phone" }, "1".repeat(33))).toBe("BAD");
    expect(ok({ type: "link" }, "https://example.com/a")).toBe("https://example.com/a");
    expect(ok({ type: "link" }, "javascript:alert(1)")).toBe("BAD");
    expect(ok({ type: "link" }, "example.com")).toBe("BAD");
  });

  it("a team member is a user id, never an address", () => {
    expect(ok({ type: "team_member" }, "u_123")).toBe("u_123");
    expect(ok({ type: "team_member" }, "alex@example.com")).toBe("BAD");
  });

  it("compares a multi select as a set", () => {
    expect(sameFieldValue(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameFieldValue(["a"], ["a", "b"])).toBe(false);
    expect(sameFieldValue(undefined, null)).toBe(true);
    expect(sameFieldValue(false, null)).toBe(false);
  });
});

describe("the list's budget", () => {
  const id = (i: number) => `fld_${String(i).padStart(12, "0")}`;
  const big = (i: number, archived: boolean): RecordField =>
    field({
      key: id(i),
      label: "L".repeat(FIELD_LIMITS.labelChars),
      type: "multi_select",
      options: Array.from({ length: FIELD_LIMITS.options }, (_, j) => ({ ...opt(j, true), label: "O".repeat(FIELD_LIMITS.labelChars) })),
      ...(archived ? { archivedAt: AT, archivedBy: "u_admin", replacedBy: id(i + 1) } : {}),
    });

  it("refuses a list at every count cap: it is over the byte budget", () => {
    const worst = Array.from({ length: FIELD_LIMITS.totalFields }, (_, i) => big(i, i >= FIELD_LIMITS.liveFields));
    expect(jsonBytes({ items: worst })).toBeGreaterThan(1024 * 1024);
    expect(fieldListProblems(worst)).toEqual(["too_large"]);
    expect(FieldListSchema.safeParse({ items: worst }).success).toBe(false);
  });

  it("so a list it accepts always fits the document limit and the settings snapshot", () => {
    const items: RecordField[] = [];
    for (let i = 0; i < FIELD_LIMITS.totalFields; i++) {
      const next = [...items, big(i, i >= FIELD_LIMITS.liveFields)];
      if (fieldListProblems(next).length) break;
      items.push(next[next.length - 1]!);
    }
    expect(items.length).toBeGreaterThan(10);
    const bytes = jsonBytes({ items });
    expect(bytes).toBeLessThanOrEqual(FIELD_LIMITS.listBytes);
    expect(bytes).toBeLessThan(SETTINGS_LIMITS.snapshotBytes);
    expect(bytes).toBeLessThan(1024 * 1024);
  });

  it("refuses too many fields, too many in use, too many options and a repeated id", () => {
    const small = (i: number, archived = false) => field({ key: id(i), label: `F${i}`, ...(archived ? { archivedAt: AT } : {}) });
    expect(fieldListProblems(Array.from({ length: 101 }, (_, i) => small(i)))).toEqual(["too_many_live_fields"]);
    expect(fieldListProblems(Array.from({ length: 301 }, (_, i) => small(i, true)))).toEqual(["too_many_fields"]);
    expect(fieldListProblems([field({ type: "select", options: Array.from({ length: 51 }, (_, i) => opt(i)) })])).toEqual(["too_many_options"]);
    expect(fieldListProblems([small(1), small(1)])).toEqual(["field_id_twice"]);
    expect(fieldListProblems([small(1)], "company")).toEqual(["wrong_object"]);
  });
});
