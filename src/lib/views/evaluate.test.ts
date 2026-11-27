import { describe, expect, it } from "vitest";
import type { RecordField } from "@/lib/types/recordField";
import { evaluateView, zoneOf, type ViewPerson } from "./evaluate";
import { emptyView, type ViewDefinition, type ViewFilter } from "./types";

const at = "2026-11-01T00:00:00.000Z";
const field = (key: string, type: RecordField["type"], extra: Partial<RecordField> = {}): RecordField =>
  ({ key, label: key, type, object: "person", archivedAt: null, createdAt: at, createdBy: null, ...extra }) as RecordField;

const TYPE = field("fld_type00000001", "select", {
  options: [
    { id: "opt_retail01", label: "Retail" },
    { id: "opt_whole001", label: "Wholesale" },
    { id: "opt_trade001", label: "Trade", archivedAt: at },
  ],
});
const STEP = field("fld_step00000001", "status", { options: [{ id: "opt_lead0001", label: "Lead" }, { id: "opt_won00001", label: "Won" }] });
const SIZES = field("fld_sizes0000001", "multi_select", { options: [{ id: "opt_large001", label: "Large" }, { id: "opt_small001", label: "Small" }] });
const NOTES = field("fld_notes0000001", "text");
const SEATS = field("fld_seats0000001", "number");
const SPEND = field("fld_spend0000001", "currency", { currency: "GBP" });
const ORDER = field("fld_order0000001", "date");
const TRADE = field("fld_trade0000001", "checkbox");
const MAIL = field("fld_mail00000001", "email");
const PHONE = field("fld_phone0000001", "phone");
const SITE = field("fld_site00000001", "link");
const OWNER = field("fld_owner0000001", "team_member");
const OLD = field("fld_old000000001", "select", { archivedAt: at, options: [{ id: "opt_large001", label: "Large" }] });
const FIELDS = [TYPE, STEP, SIZES, NOTES, SEATS, SPEND, ORDER, TRADE, MAIL, PHONE, SITE, OWNER, OLD];

// Made-up people, in the list's order (most recently active first).
const P: ViewPerson[] = [
  {
    id: "ct_a",
    sortKey: "2026-11-25T10:00:00.000Z|ct_a",
    memberOf: ["all", "launch:camp_1", "via:form", "product:con_1", "stage:con_1:stuck", "quiet:con_1", "launches:many", "group:con_1:ws.1"],
    reach: "yes",
    activeAt: "2026-11-25T10:00:00.000Z",
    firstSeenAt: "2026-01-10T09:00:00.000Z",
    emailDomain: "greenroom-cafe.example",
    firstName: "Priya",
    lastName: "Natarajan",
    fields: {
      [TYPE.key]: "opt_whole001",
      [STEP.key]: "opt_won00001",
      [SIZES.key]: ["opt_large001", "opt_small001"],
      [NOTES.key]: "Repots every spring",
      [SEATS.key]: 12,
      [SPEND.key]: 482000,
      [ORDER.key]: "2026-11-12",
      [TRADE.key]: true,
      [MAIL.key]: "accounts@greenroom-cafe.example",
      [OWNER.key]: "u_alex",
      [OLD.key]: "opt_large001",
    },
  },
  {
    id: "ct_b",
    sortKey: "2026-11-20T10:00:00.000Z|ct_b",
    memberOf: ["all", "launch:camp_2", "via:site"],
    reach: "limited",
    activeAt: "2026-11-20T10:00:00.000Z",
    firstSeenAt: "2026-06-01T09:00:00.000Z",
    emailDomain: "example.com",
    firstName: "Tom",
    lastName: "Brennan",
    fields: { [TYPE.key]: "opt_retail01", [STEP.key]: "opt_lead0001", [SIZES.key]: ["opt_small001"], [SEATS.key]: 3, [SPEND.key]: 8450, [ORDER.key]: "2026-09-30", [TRADE.key]: false },
  },
  {
    id: "ct_c",
    sortKey: "2026-11-01T10:00:00.000Z|ct_c",
    memberOf: ["all", "product:con_1", "stage:con_1:activated"],
    reach: "no",
    activeAt: "2026-11-01T10:00:00.000Z",
    firstSeenAt: "2025-12-01T09:00:00.000Z",
    emailDomain: null,
    firstName: "Aiko",
    lastName: "Tanaka",
    fields: { [TYPE.key]: "opt_whole001", [SEATS.key]: 12, [ORDER.key]: "2026-12-05", [PHONE.key]: "+44 20 7946 0000", [OWNER.key]: "u_sam" },
  },
  // Left every launch and product: not in Everyone, so never in a view, whatever their values say.
  { id: "ct_d", sortKey: "2026-11-26T10:00:00.000Z|ct_d", memberOf: [], reach: "yes", fields: { [TYPE.key]: "opt_whole001" } },
];

const NOW = new Date("2026-11-26T12:00:00.000Z");
const run = (filters: ViewFilter[], over: Partial<ViewDefinition> = {}, timeZone: string | null = null) =>
  evaluateView(P, { ...emptyView(), filters, ...over }, { fields: FIELDS, timeZone, now: NOW });
const ids = (filters: ViewFilter[], over: Partial<ViewDefinition> = {}) => run(filters, over).ids;

describe("a view in memory", () => {
  it("is everyone in Everyone with no filters, in the list's order", () => {
    expect(run([])).toMatchObject({ ids: ["ct_a", "ct_b", "ct_c"], count: 3, flags: [], sortIgnored: false });
  });

  it("reads built in filters from the list's tags, reach and times", () => {
    expect(ids([{ on: "launch", op: "any_of", value: ["camp_1", "camp_2"] }])).toEqual(["ct_a", "ct_b"]);
    expect(ids([{ on: "launch", op: "none_of", value: ["camp_1"] }])).toEqual(["ct_b", "ct_c"]);
    expect(ids([{ on: "via", op: "any_of", value: ["site"] }])).toEqual(["ct_b"]);
    expect(ids([{ on: "launches_many", op: "is", value: true }])).toEqual(["ct_a"]);
    expect(ids([{ on: "launches_many", op: "is", value: false }])).toEqual(["ct_b", "ct_c"]);
    expect(ids([{ on: "product", op: "any_of", value: ["con_1"] }])).toEqual(["ct_a", "ct_c"]);
    expect(ids([{ on: "stage", op: "any_of", value: ["con_1:stuck"] }])).toEqual(["ct_a"]);
    expect(ids([{ on: "quiet", op: "any_of", value: ["con_1"] }])).toEqual(["ct_a"]);
    expect(ids([{ on: "group", op: "any_of", value: ["con_1:ws.1"] }])).toEqual(["ct_a"]);
    expect(ids([{ on: "can_email", op: "is", value: true }])).toEqual(["ct_a"]);
    expect(ids([{ on: "can_email", op: "is", value: false }])).toEqual(["ct_b", "ct_c"]);
    expect(ids([{ on: "last_active", op: "in_last", value: 7 }])).toEqual(["ct_a", "ct_b"]);
    expect(ids([{ on: "last_active", op: "over_ago", value: 7 }])).toEqual(["ct_c"]);
    expect(ids([{ on: "first_seen", op: "before", value: "2026-01-01" }])).toEqual(["ct_c"]);
    expect(ids([{ on: "first_seen", op: "after", value: "2026-05-31" }])).toEqual(["ct_b"]);
    expect(ids([{ on: "first_seen", op: "on", value: "2026-01-10" }])).toEqual(["ct_a"]);
    expect(ids([{ on: "email_domain", op: "equals", value: "@Greenroom-Cafe.example" }])).toEqual(["ct_a"]);
    expect(ids([{ on: "email_domain", op: "not_equals", value: "example.com" }])).toEqual(["ct_a", "ct_c"]);
    expect(ids([{ on: "email_domain", op: "contains", value: "cafe" }])).toEqual(["ct_a"]);
    expect(ids([{ on: "email_domain", op: "not_contains", value: "cafe" }])).toEqual(["ct_b", "ct_c"]);
    expect(ids([{ on: "email_domain", op: "empty" }])).toEqual(["ct_c"]);
    expect(ids([{ on: "email_domain", op: "not_empty" }])).toEqual(["ct_a", "ct_b"]);
  });

  it("compares every one of the twelve field types", () => {
    // Select and status.
    expect(ids([{ on: TYPE.key, op: "any_of", value: ["opt_whole001"] }])).toEqual(["ct_a", "ct_c"]);
    expect(ids([{ on: TYPE.key, op: "none_of", value: ["opt_whole001"] }])).toEqual(["ct_b"]);
    expect(ids([{ on: STEP.key, op: "empty" }])).toEqual(["ct_c"]);
    expect(ids([{ on: STEP.key, op: "not_empty" }])).toEqual(["ct_a", "ct_b"]);
    // Multi select.
    expect(ids([{ on: SIZES.key, op: "any_of", value: ["opt_small001"] }])).toEqual(["ct_a", "ct_b"]);
    expect(ids([{ on: SIZES.key, op: "all_of", value: ["opt_large001", "opt_small001"] }])).toEqual(["ct_a"]);
    expect(ids([{ on: SIZES.key, op: "none_of", value: ["opt_large001"] }])).toEqual(["ct_b", "ct_c"]);
    // Text, with typed words; a negative comparison keeps people with no value.
    expect(ids([{ on: NOTES.key, op: "contains", value: "SPRING" }])).toEqual(["ct_a"]);
    expect(ids([{ on: NOTES.key, op: "not_contains", value: "spring" }])).toEqual(["ct_b", "ct_c"]);
    expect(ids([{ on: NOTES.key, op: "equals", value: " repots every spring " }])).toEqual(["ct_a"]);
    expect(ids([{ on: NOTES.key, op: "not_equals", value: "repots every spring" }])).toEqual(["ct_b", "ct_c"]);
    // Numbers and amounts (whole minor units).
    expect(ids([{ on: SEATS.key, op: "eq", value: 12 }])).toEqual(["ct_a", "ct_c"]);
    expect(ids([{ on: SEATS.key, op: "ne", value: 12 }])).toEqual(["ct_b"]);
    expect(ids([{ on: SEATS.key, op: "gt", value: 3 }])).toEqual(["ct_a", "ct_c"]);
    expect(ids([{ on: SEATS.key, op: "gte", value: 3 }])).toEqual(["ct_a", "ct_b", "ct_c"]);
    expect(ids([{ on: SEATS.key, op: "lt", value: 12 }])).toEqual(["ct_b"]);
    expect(ids([{ on: SEATS.key, op: "lte", value: 12 }])).toEqual(["ct_a", "ct_b", "ct_c"]);
    expect(ids([{ on: SPEND.key, op: "between", value: [5000, 100000] }])).toEqual(["ct_b"]);
    expect(ids([{ on: SPEND.key, op: "empty" }])).toEqual(["ct_c"]);
    // Dates: calendar days.
    expect(ids([{ on: ORDER.key, op: "in_last", value: 30 }])).toEqual(["ct_a"]);
    expect(ids([{ on: ORDER.key, op: "in_last", value: 60 }])).toEqual(["ct_a", "ct_b"]);
    expect(ids([{ on: ORDER.key, op: "in_next", value: 14 }])).toEqual(["ct_c"]);
    expect(ids([{ on: ORDER.key, op: "over_ago", value: 30 }])).toEqual(["ct_b"]);
    expect(ids([{ on: ORDER.key, op: "on", value: "2026-11-12" }])).toEqual(["ct_a"]);
    expect(ids([{ on: ORDER.key, op: "before", value: "2026-11-12" }])).toEqual(["ct_b"]);
    expect(ids([{ on: ORDER.key, op: "after", value: "2026-11-12" }])).toEqual(["ct_c"]);
    // A box: No is anyone not ticked.
    expect(ids([{ on: TRADE.key, op: "is", value: true }])).toEqual(["ct_a"]);
    expect(ids([{ on: TRADE.key, op: "is", value: false }])).toEqual(["ct_b", "ct_c"]);
    // Email, phone and link: only whether there is one.
    expect(ids([{ on: MAIL.key, op: "not_empty" }])).toEqual(["ct_a"]);
    expect(ids([{ on: PHONE.key, op: "not_empty" }])).toEqual(["ct_c"]);
    expect(ids([{ on: SITE.key, op: "empty" }])).toEqual(["ct_a", "ct_b", "ct_c"]);
    // Team member, by user id.
    expect(ids([{ on: OWNER.key, op: "any_of", value: ["u_sam"] }])).toEqual(["ct_c"]);
    expect(ids([{ on: OWNER.key, op: "none_of", value: ["u_sam"] }])).toEqual(["ct_a", "ct_b"]);
    expect(ids([{ on: OWNER.key, op: "empty" }])).toEqual(["ct_b"]);
  });

  it("joins filters with all of these or any of these", () => {
    const filters: ViewFilter[] = [
      { on: TYPE.key, op: "any_of", value: ["opt_whole001"] },
      { on: "can_email", op: "is", value: true },
    ];
    expect(ids(filters)).toEqual(["ct_a"]);
    expect(ids(filters, { match: "any" })).toEqual(["ct_a", "ct_c"]);
  });

  it("flags and ignores a filter on an archived field, and leaves an archived option out", () => {
    const r = run([
      { on: OLD.key, op: "any_of", value: ["opt_large001"] },
      { on: TYPE.key, op: "any_of", value: ["opt_trade001", "opt_retail01"] },
    ]);
    expect(r.flags).toEqual(["archived_field", "archived_option"]);
    expect(r.ids).toEqual(["ct_b"]);
    // With every filter ignored, the view is everyone.
    expect(run([{ on: OLD.key, op: "any_of", value: ["opt_large001"] }]).ids).toEqual(["ct_a", "ct_b", "ct_c"]);
  });

  it("sorts stably, with no value last whichever way", () => {
    expect(ids([], { sort: { by: SPEND.key, dir: "desc" } })).toEqual(["ct_a", "ct_b", "ct_c"]);
    expect(ids([], { sort: { by: SPEND.key, dir: "asc" } })).toEqual(["ct_b", "ct_a", "ct_c"]);
    // A and C share 12 seats: they keep the list's order both ways.
    expect(ids([], { sort: { by: SEATS.key, dir: "desc" } })).toEqual(["ct_a", "ct_c", "ct_b"]);
    expect(ids([], { sort: { by: SEATS.key, dir: "asc" } })).toEqual(["ct_b", "ct_a", "ct_c"]);
    expect(ids([], { sort: { by: "person", dir: "asc" } })).toEqual(["ct_c", "ct_a", "ct_b"]);
    expect(ids([], { sort: { by: STEP.key, dir: "asc" } })).toEqual(["ct_b", "ct_a", "ct_c"]);
    expect(ids([], { sort: { by: "first_seen", dir: "asc" } })).toEqual(["ct_c", "ct_a", "ct_b"]);
    expect(ids([], { sort: { by: "can_email", dir: "desc" } })).toEqual(["ct_a", "ct_b", "ct_c"]);
    expect(ids([], { sort: { by: TRADE.key, dir: "desc" } })).toEqual(["ct_a", "ct_b", "ct_c"]);
    expect(ids([], { sort: { by: ORDER.key, dir: "asc" } })).toEqual(["ct_b", "ct_a", "ct_c"]);
    expect(ids([], { sort: { by: NOTES.key, dir: "asc" } })).toEqual(["ct_a", "ct_b", "ct_c"]);
    const ignored = run([], { sort: { by: OLD.key, dir: "asc" } });
    expect(ignored).toMatchObject({ ids: ["ct_a", "ct_b", "ct_c"], sortIgnored: true });
  });

  it("counts days in the brand's time zone", () => {
    // 23:30 on 25 Nov in UTC is already 26 Nov in Auckland and still 25 Nov in Los Angeles.
    const late: ViewPerson[] = [{ id: "ct_z", memberOf: ["all"], activeAt: "2026-11-25T23:30:00.000Z" }];
    const on26 = (tz: string | null) =>
      evaluateView(late, { ...emptyView(), filters: [{ on: "last_active", op: "on", value: "2026-11-26" }] }, { fields: [], timeZone: tz, now: NOW }).count;
    expect(on26(null)).toBe(0);
    expect(on26("Pacific/Auckland")).toBe(1);
    expect(on26("America/Los_Angeles")).toBe(0);
    expect(on26("Not/AZone")).toBe(0);
    expect(zoneOf("Not/AZone")).toBe("UTC");
    expect(zoneOf("Europe/London")).toBe("Europe/London");
  });
});
