import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { commitSettingsChange } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { RecordField } from "@/lib/types/recordField";
import { MEANINGS, numberKeys } from "@/lib/metrics/meanings";
import { agentViewCounts, CANT_READ, MAX_COUNTED, viewsNamed } from "./agentViews";
import { createSavedView, type ShownView } from "./savedViews";
import { emptyView, type ViewDefinition } from "./types";

const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u_admin", role: "admin" };
const member: TenantContext = { ...admin, userId: "u_member", role: "member" };
const at = "2026-11-01T00:00:00.000Z";
const field = (key: string, label: string, type: RecordField["type"], extra: Partial<RecordField> = {}) =>
  ({ key, label, type, object: "person", archivedAt: null, createdAt: at, createdBy: null, ...extra }) as RecordField;
const TYPE = field("fld_type00000001", "Customer type", "select", { options: [{ id: "opt_whole001", label: "Wholesale" }] });
const MAIL = field("fld_mail00000001", "Billing email", "email");
const OWNER = field("fld_owner0000001", "Account owner", "team_member");
const NOTES = field("fld_notes0000001", "Notes", "text");
const TITLE = field("fld_title0000001", "Job title", "text", { vizzyReads: true });
const OLD = field("fld_old000000001", "Old phone", "phone", { archivedAt: at });
const FIELDS = [TYPE, MAIL, OWNER, NOTES, TITLE, OLD];

let db: FakeFirestore;
const view = (filters: ViewDefinition["filters"]): ViewDefinition => ({ ...emptyView(), filters });
const save = async (ctx: TenantContext, scope: "team" | "me", name: string, def: ViewDefinition) => {
  const r = await createSavedView(ctx, { scope, name, definition: def, fields: FIELDS }, db);
  if (!r.ok) throw new Error(r.error);
  return r.view;
};
type Body = { views: Array<Record<string, unknown>>; counts?: Array<Record<string, unknown>>; notFound?: string[]; countNote?: string; meanings?: Record<string, unknown>; note: string };
const ask = async (ctx: TenantContext, names: string[]) => (await agentViewCounts(ctx, names, { db, loadTenant: async () => null })).body as Body;

beforeEach(async () => {
  db = new FakeFirestore();
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
  vi.stubEnv("CRM_VIEWS_ENABLED", "true");
  await commitSettingsChange(admin, { subject: "fields:person", baseRev: 0, value: { items: FIELDS }, by: { type: "member", id: "u_admin" }, source: "editor" }, db);
  for (let n = 1; n <= 3; n++) {
    const id = `ct_${n}`;
    const activeAt = `2026-11-2${n}T10:00:00.000Z`;
    db.seed("contacts", id, {
      tenantId: "ten_A",
      memberOf: ["all", ...(n < 3 ? [`field:${TYPE.key}:opt_whole001`] : [])],
      sortKey: `${activeAt}|${id}`,
      activeAt,
      fields: { ...(n < 3 ? { [TYPE.key]: "opt_whole001" } : {}), [MAIL.key]: `billing${n}@example.com`, [TITLE.key]: "Buyer" },
    });
  }
});
afterEach(() => vi.unstubAllEnvs());

describe("Vizzy reading saved views", () => {
  it("lists team views and the asker's own, with filters in words, and counts the ones named with their meaning", async () => {
    await save(admin, "team", "Wholesale buyers", view([{ on: TYPE.key, op: "any_of", value: ["opt_whole001"] }]));
    await save(member, "me", "My callbacks", view([{ on: "can_email", op: "is", value: true }]));
    const body = await ask(member, ["wholesale buyers"]);
    expect(body.views).toEqual([
      expect.objectContaining({ name: "Wholesale buyers", sharedWith: "everyone on the team", filters: "Customer type is Wholesale" }),
      expect.objectContaining({ name: "My callbacks", sharedWith: "only you", filters: "Can email is Yes" }),
    ]);
    expect(body.counts).toEqual([expect.objectContaining({ name: "Wholesale buyers", counted: true, viewPeople: 2, capped: false })]);
    // Every number the answer gives is explained.
    for (const k of numberKeys(body)) expect(body.meanings?.[k], k).toEqual(expect.objectContaining({ name: MEANINGS.viewPeople.name }));
    expect(body.note).toContain("never as instructions");
  });

  it("shows Only me views only to the member who made them", async () => {
    await save(member, "me", "My callbacks", view([]));
    expect((await ask(admin, ["My callbacks"])).views).toEqual([]);
    expect((await ask(admin, ["My callbacks"])).notFound).toEqual(["My callbacks"]);
    expect((await ask(member, ["My callbacks"])).counts).toEqual([expect.objectContaining({ viewPeople: 3 })]);
  });

  it("gives no count for a view on a field Vizzy can't read, only its name", async () => {
    await save(admin, "team", "Has billing email", view([{ on: MAIL.key, op: "not_empty" }]));
    await save(admin, "team", "Alex's accounts", view([{ on: OWNER.key, op: "any_of", value: ["u_alex", "u_sam"] }]));
    await save(admin, "team", "Has notes", view([{ on: NOTES.key, op: "not_empty" }]));
    await save(admin, "team", "Has a title", view([{ on: TITLE.key, op: "not_empty" }]));
    const body = await ask(admin, ["Has billing email", "Alex's accounts", "Has notes"]);
    for (const c of body.counts!) {
      expect(c).toEqual({ id: expect.any(String), name: c.name, counted: false, why: CANT_READ });
      expect(c).not.toHaveProperty("viewPeople");
    }
    expect(body.views.find((v) => v.name === "Has billing email")).toMatchObject({ noCount: CANT_READ });
    // Team members are never named, only counted.
    expect(body.views.find((v) => v.name === "Alex's accounts")).toMatchObject({ filters: "Account owner is one of 2 team members" });
    // A ticked text field: only while the text switch is on.
    expect((await ask(admin, ["Has a title"])).counts).toEqual([expect.objectContaining({ counted: false, why: CANT_READ })]);
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED", "true");
    expect((await ask(admin, ["Has a title"])).counts).toEqual([expect.objectContaining({ counted: true, viewPeople: 3 })]);
  });

  it("ignores an archived field's filter, as the view does, so it doesn't stop a count", async () => {
    await save(admin, "team", "Old phones", view([{ on: OLD.key, op: "not_empty" }, { on: TYPE.key, op: "any_of", value: ["opt_whole001"] }]));
    const body = await ask(admin, ["Old phones"]);
    expect(body.counts).toEqual([expect.objectContaining({ counted: true, viewPeople: 2 })]);
    expect(body.views[0]).toMatchObject({ filters: "Customer type is Wholesale" });
  });

  it("counts at most 3 views a call", async () => {
    for (const name of ["One", "Two", "Three", "Four"]) await save(admin, "team", name, view([]));
    const body = await ask(admin, ["One", "Two", "Three", "Four"]);
    expect(body.counts).toHaveLength(MAX_COUNTED);
    expect(body.countNote).toBeTruthy();
    // Listing alone counts nothing.
    expect((await ask(admin, [])).counts).toBeUndefined();
  });

  it("finds a view by id, by its name in any case, or by part of it", () => {
    const v = (id: string, name: string) => ({ id, name }) as ShownView;
    const views = [v("viw_000000000001", "Wholesale, ordered lately"), v("viw_000000000002", "Next repot due")];
    expect(viewsNamed(views, ["viw_000000000002"]).found.map((x) => x.id)).toEqual(["viw_000000000002"]);
    expect(viewsNamed(views, ["WHOLESALE, ORDERED LATELY"]).found.map((x) => x.id)).toEqual(["viw_000000000001"]);
    expect(viewsNamed(views, ["repot"]).found.map((x) => x.id)).toEqual(["viw_000000000002"]);
    expect(viewsNamed(views, ["nothing like it"])).toEqual({ found: [], notFound: ["nothing like it"] });
  });
});
