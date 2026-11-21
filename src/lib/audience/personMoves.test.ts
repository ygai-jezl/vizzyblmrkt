import { describe, expect, it } from "vitest";
import { EventWriteSchema } from "@/lib/types/ontologyEvent";
import { deterministicContactId } from "@/lib/crm/identifiers";
import type { ContactPersonId } from "@/lib/ontology/person";
import { moveEvents, moveKey, movesOf, parseMoveFieldId } from "./personMoves";

const PERSON = deterministicContactId("ten_A", "sam@example.com") as ContactPersonId;
const AT = "2026-11-21T09:00:00.000Z";

describe("movesOf", () => {
  it("turns a stage swap in one product into one move, from one stage to the other", () => {
    expect(movesOf({ added: ["stage:pcn_app:activated"], removed: ["stage:pcn_app:onboarding"] })).toEqual([
      { kind: "stage", on: "pcn_app", fieldId: "sys.stage.pcn_app", keyTag: "stage:pcn_app", before: "onboarding", after: "activated" },
    ]);
  });

  it("records launches, products and quiet as in or out, and a first stage from nothing", () => {
    const moves = movesOf({
      added: ["launch:spring", "product:pcn_app", "stage:pcn_app:new", "quiet:pcn_old"],
      removed: ["launch:beta"],
    });
    expect(moves.map((m) => [m.fieldId, m.before, m.after])).toEqual([
      ["sys.launch.beta", true, false],
      ["sys.launch.spring", false, true],
      ["sys.product.pcn_app", false, true],
      ["sys.stage.pcn_app", null, "new"],
      ["sys.quiet.pcn_old", false, true],
    ]);
  });

  it("ignores everything else: derived tags, groups, fields, the hand-added mark and unknown prefixes", () => {
    const ignored = [
      "all",
      "launch:any",
      "product:any",
      "via:form",
      "via:site",
      "group:pcn_app:ws.1",
      "field:fld_000000000001:opt_00000001",
      "field:fld_000000000002:yes",
      "added:hand",
      "launches:many",
      "segment:vip",
      "stage:pcn_app:sleeping",
      "launch:a:b",
    ];
    expect(movesOf({ added: ignored, removed: ignored })).toEqual([]);
  });
});

describe("moveEvents", () => {
  it("makes one checked record.field_changed per move, keyed so a retry writes nothing twice", () => {
    const moves = movesOf({ added: ["stage:pcn_app:stuck", "launch:spring"], removed: ["stage:pcn_app:onboarding"] });
    const rows = moveEvents(PERSON, AT, moves, new Map([["pcn_app", "pu_7"]]));
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(EventWriteSchema.safeParse(r).success).toBe(true);
    expect(rows[0]).toMatchObject({
      key: moveKey(PERSON, AT, "launch:spring"),
      kind: "record.field_changed",
      personId: PERSON,
      productUserId: null,
      fieldId: "sys.launch.spring",
      actor: { type: "system", id: null },
      properties: { fieldId: "sys.launch.spring", object: "person", before: false, after: true, source: "sync" },
    });
    expect(rows[1]).toMatchObject({ key: `move|${PERSON}|${AT}|stage:pcn_app`, productUserId: "pu_7", properties: { before: "onboarding", after: "stuck" } });
    expect(moveEvents(PERSON, AT, moves, new Map([["pcn_app", "pu_7"]]))).toEqual(rows);
  });
});

describe("parseMoveFieldId", () => {
  it("reads a move's field id, and nothing else", () => {
    expect(parseMoveFieldId("sys.stage.pcn_app")).toEqual({ kind: "stage", on: "pcn_app" });
    expect(parseMoveFieldId("sys.launch.spring")).toEqual({ kind: "launch", on: "spring" });
    expect(parseMoveFieldId("fld_000000000001")).toBeNull();
    expect(parseMoveFieldId("sys.status.idea")).toBeNull();
    expect(parseMoveFieldId("sys.stage.a.b")).toBeNull();
  });
});
