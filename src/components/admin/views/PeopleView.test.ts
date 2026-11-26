import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RecordField } from "@/lib/types/recordField";
import { BUILT_IN_FILTERS, emptyView, type ViewDefinition } from "@/lib/views/types";
import { VIEW_MESSAGES, type ViewNames } from "@/lib/views/words";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
const { PeopleView } = await import("./PeopleView");
const { SaveViewDialog } = await import("./SaveViewDialog");
const { FilterBuilder, blankDraft, draftOf, filterOf, newDraft } = await import("./FilterBuilder");

// Made-up brand: a plant shop's People fields.
const at = "2026-11-01T00:00:00.000Z";
const f = (key: string, label: string, type: RecordField["type"], extra: Partial<RecordField> = {}) =>
  ({ key, label, type, object: "person", archivedAt: null, createdAt: at, createdBy: null, ...extra }) as RecordField;
const TYPE = f("fld_type00000001", "Customer type", "select", { options: [{ id: "opt_retail01", label: "Retail" }, { id: "opt_whole001", label: "Wholesale" }] });
const ORDER = f("fld_order0000001", "Last order", "date");
const SPEND = f("fld_spend0000001", "Spend this year", "currency", { currency: "GBP" });
const SIZE = f("fld_size00000001", "Pot size", "multi_select", { archivedAt: at, options: [{ id: "opt_large001", label: "Large" }] });
const NOTES = f("fld_notes0000001", "Notes", "text");
const names: ViewNames = { fields: [TYPE, ORDER, SPEND, SIZE, NOTES], launches: [{ id: "camp_1", name: "Spring bulb club" }], products: [], team: [], ideas: true };

const WHOLESALE: ViewDefinition = {
  match: "all",
  filters: [
    { on: TYPE.key, op: "any_of", value: ["opt_whole001"] },
    { on: ORDER.key, op: "in_last", value: 60 },
    { on: "can_email", op: "is", value: true },
  ],
  columns: ["person", TYPE.key, ORDER.key, SPEND.key, "can_email", "last_active"],
  sort: { by: SPEND.key, dir: "desc" },
};
const team = { id: "viw_000000000001", scope: "team" as const, name: "Next repot due", definition: WHOLESALE, version: 1, archived: false, changedAt: at, changedBy: "u_admin" };

const view = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(PeopleView, {
      open: { ...WHOLESALE, saved: null, from: "Everyone", q: "" },
      names,
      manyLaunches: false,
      everyone: 7812,
      isAdmin: true,
      lists: { team: [team], archived: [], mine: [], canSaveTeam: true },
      multiProduct: false,
      newPersonButton: null,
      onOpen: () => {},
      onSaved: () => {},
      onBringBack: () => {},
      ...over,
    }),
  );

describe("People as a view", () => {
  it("shows an unsaved view from the list's group, its filters, columns, sort and Save view", () => {
    const html = view();
    expect(html).toContain("<strong>Unsaved view</strong> <span class=\"text-neutral-500\">from Everyone</span>");
    expect(html).toContain("Show people who match");
    expect(html).toContain("All of these");
    expect(html).toContain("Sort: Spend this year, high to low");
    expect(html).toContain("Search this view by name, email or domain");
    expect(html).toMatch(/<button[^>]*>Save view<\/button>/);
    expect(html).toContain(">Wholesale<");
  });

  it("gives a member Save as my view on a team view, and marks it as the team's", () => {
    const html = view({ open: { ...WHOLESALE, saved: team, from: "Everyone", q: "" }, isAdmin: false });
    expect(html).toContain("Next repot due");
    expect(html).toContain("Team view");
    expect(html).toContain("Save as my view");
    expect(html).not.toContain("More for this view");
  });

  it("marks a filter on an archived field, with its options struck through, and says it is ignored", () => {
    const html = view({ open: { ...WHOLESALE, filters: [{ on: SIZE.key, op: "any_of", value: ["opt_large001"] }], saved: null, from: "Everyone", q: "" } });
    expect(html).toContain("Pot size (archived)");
    expect(html).toContain(">Archived<");
    expect(html).toContain(VIEW_MESSAGES.archived_field);
  });

  it("marks typed words and won't save them", () => {
    const html = view({ open: { ...emptyView(), filters: [{ on: "email_domain", op: "equals", value: "greenroom-cafe.example" }], saved: null, from: "Everyone", q: "" } });
    // React writes an apostrophe as &#x27;.
    expect(html).toContain(VIEW_MESSAGES.typed_words.replace(/'/g, "&#x27;"));
    expect(html).toContain("Typed words");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save view<\/button>/);
  });

  it("shows an archived team view to an admin with Bring back", () => {
    const html = view({ open: { ...WHOLESALE, saved: { ...team, archived: true }, from: "Everyone", q: "" } });
    expect(html).toContain(VIEW_MESSAGES.archived_view);
    expect(html).toMatch(/<button[^>]*>Bring back<\/button>/);
  });
});

describe("the filter builder", () => {
  it("offers a value for each kind of comparison", () => {
    const drafts = [
      draftOf({ on: SPEND.key, op: "between", value: [100000, 500000] }, names.fields),
      draftOf({ on: ORDER.key, op: "before", value: "2026-11-12" }, names.fields),
      draftOf({ on: NOTES.key, op: "not_empty" }, names.fields),
      draftOf({ on: "launch", op: "none_of", value: ["camp_1"] }, names.fields),
    ];
    const html = renderToStaticMarkup(createElement(FilterBuilder, { match: "any", drafts, flags: {}, names, manyLaunches: false, onMatch: () => {}, onChange: () => {} }));
    // An amount is typed in the currency's own units.
    expect(html).toContain('value="1000.00"');
    expect(html).toContain('value="5000.00"');
    expect(html).toContain('type="date"');
    expect(html).toContain("Spring bulb club");
    expect(html).toContain(">Idea<");
    expect(html).toContain("Clear all");
  });
});

describe("a saved view's product group", () => {
  it("shows the group filter and its name when the page wasn't opened from the group", () => {
    const drafts = [draftOf({ on: "group", op: "any_of", value: ["con_1:ws-42"] }, names.fields)];
    const withGroups: ViewNames = { ...names, products: [{ id: "con_1", name: "Fernhill online shop" }], groups: [{ id: "con_1:ws-42", label: "Workspace Hillside" }] };
    const html = renderToStaticMarkup(createElement(FilterBuilder, { match: "all", drafts, flags: {}, names: withGroups, manyLaunches: false, onMatch: () => {}, onChange: () => {} }));
    // React marks the chosen option selected.
    expect(html).toMatch(/<option value="group" selected="">Product group<\/option>/);
    expect(html).toContain("Workspace Hillside");
    // Without its name, it is named from its product, never as some other field.
    const bare = renderToStaticMarkup(createElement(FilterBuilder, { match: "all", drafts, flags: {}, names: { ...withGroups, groups: [] }, manyLaunches: false, onMatch: () => {}, onChange: () => {} }));
    expect(bare).toMatch(/<option value="group" selected="">Product group<\/option>/);
    expect(bare).toContain("A group in Fernhill online shop");
  });
});

describe("a new filter", () => {
  const OPT_IN = f("fld_optin0000001", "Newsletter opt in", "checkbox");
  const EMAIL = f("fld_email0000001", "Billing email", "email");
  const SITE = f("fld_site00000001", "Website", "link");
  const PHONE = f("fld_phone0000001", "Shop phone", "phone");
  const withAll: ViewNames = { ...names, fields: [OPT_IN, EMAIL, SITE, PHONE, ...names.fields] };

  it("applies nothing until someone picks, whatever it is on", () => {
    expect(filterOf(blankDraft())).toBeNull();
    for (const on of [...withAll.fields.map((x) => x.key), ...BUILT_IN_FILTERS]) expect(filterOf(newDraft(on, withAll.fields))).toBeNull();
    // A ticked box needs Yes or No picked; email, phone and link start with no comparison.
    const box = newDraft(OPT_IN.key, withAll.fields);
    expect([box.op, box.value]).toEqual(["is", undefined]);
    for (const x of [EMAIL, SITE, PHONE]) expect(newDraft(x.key, withAll.fields).op).toBeNull();
    expect(filterOf({ ...newDraft(OPT_IN.key, withAll.fields), value: true })).toEqual({ on: OPT_IN.key, op: "is", value: true });
  });

  it("shows what is left to pick", () => {
    const drafts = [blankDraft(), newDraft(OPT_IN.key, withAll.fields), newDraft(EMAIL.key, withAll.fields)];
    const html = renderToStaticMarkup(createElement(FilterBuilder, { match: "all", drafts, flags: {}, names: withAll, manyLaunches: false, onMatch: () => {}, onChange: () => {} }));
    expect(html).toContain("Pick a filter…");
    expect(html.match(/<select aria-label="Yes or no"[\s\S]*?<\/select>/)?.[0]).toContain("Pick…");
    expect(html.match(/<select aria-label="Comparison"[\s\S]*?<\/select>/)?.[0]).toContain("Pick…");
  });
});

describe("Save view", () => {
  it("lets an admin keep it for the team or for themselves, and says what it keeps", () => {
    const html = renderToStaticMarkup(createElement(SaveViewDialog, { title: "Save view", definition: WHOLESALE, names, isAdmin: true, onCancel: () => {}, onSave: async () => null }));
    expect(html).toContain("Everyone on the team");
    expect(html).toContain("Admins can change it. Each change is kept in the settings history.");
    expect(html).toContain("3 filters: Customer type is Wholesale, Last order in the last 60 days, Can email is Yes");
    expect(html).toContain("Sorted by Spend this year, high to low");
    expect(html).toContain("6 columns");
    expect(html).toContain("The search box isn\u2019t saved.");
  });

  it("gives a member Only me, with the team choice greyed out", () => {
    const html = renderToStaticMarkup(createElement(SaveViewDialog, { title: "Save view", definition: WHOLESALE, names, isAdmin: false, onCancel: () => {}, onSave: async () => null }));
    // React writes an input's value and checked last.
    const radio = (value: string) => html.match(new RegExp(`<input type="radio"[^>]*value="${value}"[^>]*>`))?.[0] ?? "";
    expect(radio("team")).toContain('disabled=""');
    expect(radio("me")).toContain('checked=""');
    expect(radio("me")).not.toContain("disabled");
    expect(html).toContain(VIEW_MESSAGES.admins_only);
  });
});
