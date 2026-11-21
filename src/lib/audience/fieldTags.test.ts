import { describe, expect, it } from "vitest";
import type { RecordField } from "@/lib/types/recordField";
import { fieldTag, fieldTagsFor, MAX_FIELD_TAGS, parseFieldTag, sameFieldTags, withFieldTags } from "./fieldTags";

const AT = "2026-11-21T10:00:00.000Z";
const f = (key: string, type: RecordField["type"], archived = false) => ({ key, type, ...(archived ? { archivedAt: AT } : {}) }) as RecordField;
const PLAN = "fld_000000000001";
const DONE = "fld_000000000002";
const TOPICS = "fld_000000000003";
const NOTES = "fld_000000000004";
const STATUS = "fld_000000000005";

describe("field tags", () => {
  it("tags select, status, each multi select option and a ticked box", () => {
    const fields = [f(PLAN, "select"), f(DONE, "checkbox"), f(TOPICS, "multi_select"), f(NOTES, "text"), f(STATUS, "status")];
    const { tags, dropped } = fieldTagsFor(fields, { [PLAN]: "opt_00000001", [DONE]: true, [TOPICS]: ["opt_00000002", "opt_00000003"], [NOTES]: "hi", [STATUS]: "opt_00000009" });
    expect(dropped).toBe(0);
    expect(tags).toEqual(
      [`field:${PLAN}:opt_00000001`, `field:${DONE}:yes`, `field:${TOPICS}:opt_00000002`, `field:${TOPICS}:opt_00000003`, `field:${STATUS}:opt_00000009`].sort(),
    );
    expect(fieldTagsFor([f(DONE, "checkbox")], { [DONE]: false }).tags).toEqual([]);
  });

  it("keeps an archived field's tags with its values", () => {
    expect(fieldTagsFor([f(PLAN, "select", true)], { [PLAN]: "opt_00000001" }).tags).toEqual([`field:${PLAN}:opt_00000001`]);
  });

  it("makes none for a value the list has no field for", () => {
    expect(fieldTagsFor([], { [PLAN]: "opt_00000001" }).tags).toEqual([]);
  });

  it("drops tags past the cap and says how many", () => {
    const fields = Array.from({ length: 60 }, (_, i) => f(`fld_${String(i).padStart(12, "0")}`, "checkbox"));
    const values = Object.fromEntries(fields.map((x) => [x.key, true]));
    const r = fieldTagsFor(fields, values);
    expect(r.tags).toHaveLength(MAX_FIELD_TAGS);
    expect(r.dropped).toBe(10);
  });

  it("replaces only field tags, sorted, and compares them as sets", () => {
    expect(withFieldTags(["all", `field:${PLAN}:opt_00000001`, "launch:any"], [`field:${DONE}:yes`])).toEqual(["all", `field:${DONE}:yes`, "launch:any"]);
    expect(withFieldTags(undefined, [])).toEqual([]);
    expect(sameFieldTags(["all", fieldTag(PLAN, "yes")], [fieldTag(PLAN, "yes")])).toBe(true);
    expect(sameFieldTags([], [fieldTag(PLAN, "yes")])).toBe(false);
  });

  it("parses only tags the writer makes", () => {
    expect(parseFieldTag(`field:${PLAN}:opt_00000001`)).toEqual({ fieldId: PLAN, value: "opt_00000001" });
    expect(parseFieldTag(`field:${PLAN}:yes`)).toEqual({ fieldId: PLAN, value: "yes" });
    expect(parseFieldTag(`field:${PLAN}:no`)).toBeNull();
    expect(parseFieldTag("field:x:yes")).toBeNull();
    expect(parseFieldTag(`field:${PLAN}:yes:extra`)).toBeNull();
    expect(parseFieldTag("launch:any")).toBeNull();
  });
});

describe("the backfill's plan", () => {
  it("rebuilds field tags from stored values, keeps every other tag, and is safe to run again", async () => {
    const { fieldTagRepair } = await import("./fieldTags");
    const fields = [f(PLAN, "select"), f(DONE, "checkbox")];
    const values = { [PLAN]: "opt_00000001", [DONE]: true };
    const first = fieldTagRepair(fields, values, ["all", "launch:any", `field:${PLAN}:opt_00000009`]);
    expect(first).toEqual({ memberOf: ["all", `field:${DONE}:yes`, `field:${PLAN}:opt_00000001`, "launch:any"].sort(), dropped: 0 });
    expect(fieldTagRepair(fields, values, first!.memberOf)).toBeNull();
    expect(fieldTagRepair(fields, {}, ["all"])).toBeNull();
    expect(fieldTagRepair(fields, {}, ["all", `field:${PLAN}:opt_00000001`])).toEqual({ memberOf: ["all"], dropped: 0 });
  });
});
