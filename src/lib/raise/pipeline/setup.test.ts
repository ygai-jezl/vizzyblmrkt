import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { commitSettingsChange } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { readFieldList, saveFieldListChange } from "@/lib/audience/fieldList";
import { assertNoRemoval } from "@/lib/settings/archive";
import { FIELD_LIMITS, type RecordField } from "@/lib/types/recordField";
import { raiseFieldsOf } from "./fields";
import { applyRaiseSetup, firstKitOf, planRaiseSetup, setupPreviewRequest, setupRequest, type SetupPlan } from "./setup";

const admin: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "u_admin", role: "admin" };
const other: TenantContext = { ...admin, tenantId: "ten_b" };
const by = { type: "member", id: "u_admin" } as const;
const NOW = "2026-11-26T09:00:00.000Z";
const at = "2026-11-01T00:00:00.000Z";

let n = 0;
const ids = () => ({ newFieldId: () => `fld_${String(++n).padStart(12, "0")}`, newOptionId: () => `opt_${String(++n).padStart(8, "0")}` });
const field = (key: string, label: string, type: RecordField["type"], extra: Partial<RecordField> = {}) =>
  ({ key, label, type, object: "person", archivedAt: null, archivedBy: null, replacedBy: null, createdAt: at, createdBy: null, ...extra }) as RecordField;
const opt = (id: string, label: string, archivedAt: string | null = null) => ({ id, label, archivedAt });
const plan = (items: RecordField[], kit: "raising" | "funding" = "raising", currency = "GBP") => {
  const p = planRaiseSetup(items, kit, { currency, nowIso: NOW, userId: "u_admin", ...ids() });
  if (!p.ok) throw new Error(p.error);
  return p;
};
const labels = (f: RecordField | undefined) => (f?.options ?? []).map((o) => o.label);
const versions = (db: FakeFirestore, tenantId = "ten_a") => db.dump("settings_versions").filter((v) => v.tenantId === tenantId);

let db: FakeFirestore;
beforeEach(() => {
  n = 0;
  db = new FakeFirestore();
});
afterEach(() => vi.unstubAllEnvs());

describe("planRaiseSetup", () => {
  it("adds the ten fields to an empty brand, each field and option marked", () => {
    const p = plan([]);
    expect(p.addFields.map((f) => f.label)).toEqual(["Relationship", "Firm", "Tier", "Cheque", "Route in", "Last touch", "Next step", "Next step date", "Stage", "Pass reason"]);
    expect(p.added).toEqual({ fields: 10, options: 3 + 3 + 10 + 23 });
    expect(p.items.map((f) => f.preset)).toEqual([
      "raise.relationship",
      "raise.firm",
      "raise.tier",
      "raise.cheque",
      "raise.route_in",
      "raise.last_touch",
      "raise.next_step",
      "raise.next_step_date",
      "raise.stage",
      "raise.pass_reason",
    ]);
    for (const f of p.items) for (const o of f.options ?? []) expect(o.preset).toMatch(/^[a-z_]+$/);
    expect(p.items.find((f) => f.preset === "raise.cheque")).toMatchObject({ type: "currency", currency: "GBP" });
    expect(p.items.find((f) => f.preset === "raise.stage")!.type).toBe("status");
    const r = raiseFieldsOf(p.items);
    expect(r.setUp).toBe(true);
    expect(r.kinds).toEqual(["raising"]);
    expect(p.nothing).toBe(false);
  });

  it("plans nothing on a second press", () => {
    const first = plan([]);
    const second = plan(first.items);
    expect(second.nothing).toBe(true);
    expect(second.addFields).toEqual([]);
    expect(second.addOptions).toEqual([]);
    expect(second.items).toEqual(first.items);
  });

  it("keeps the team's own Stage: every option, id, label and order, with the missing ones in place", () => {
    const stage = field("fld_ownstage0001", "Stage", "select", {
      options: [opt("opt_research", "Research"), opt("opt_contactd", "Contacted"), opt("opt_meeting1", "Meeting"), opt("opt_diligenc", "Diligence"), opt("opt_committd", "Committed"), opt("opt_passed01", "Passed")],
    });
    const p = plan([stage]);
    const after = p.items.find((f) => f.key === stage.key)!;
    expect(after.label).toBe("Stage");
    expect(after.type).toBe("select");
    expect(labels(after)).toEqual(["Research", "Contacted", "Replied", "First meeting", "Next meeting", "Meeting", "Diligence", "Term sheet", "Committed", "Money in", "Passed"]);
    // Every option it had is still there, unchanged but for its marker, in the same order.
    const kept = after.options!.filter((o) => stage.options!.some((s) => s.id === o.id));
    expect(kept.map((o) => [o.id, o.label])).toEqual(stage.options!.map((o) => [o.id, o.label]));
    expect(kept.map((o) => o.preset ?? null)).toEqual(["research", "contacted", null, "diligence", "committed", "passed"]);
    expect(p.adopt).toEqual([{ label: "Stage" }]);
    expect(p.addFields.map((f) => f.label)).not.toContain("Stage");
    expect(() => assertNoRemoval([stage], p.items)).not.toThrow();
  });

  it("adopts Committed under either name, and never renames it", () => {
    for (const name of ["Committed (a promise)", "committed"]) {
      const stage = field("fld_ownstage0002", "Pipeline stage", "status", { options: [opt("opt_committd", name)] });
      const after = plan([stage]).items.find((f) => f.key === stage.key)!;
      expect(after.preset).toBe("raise.stage");
      expect(after.label).toBe("Pipeline stage");
      expect(after.options!.find((o) => o.id === "opt_committd")).toMatchObject({ label: name, preset: "committed" });
      expect(after.options!.filter((o) => o.preset === "committed")).toHaveLength(1);
    }
  });

  it("keeps a text Stage as it is, adds no second Stage, and leaves the board unbound", () => {
    const stage = field("fld_textstage001", "Stage", "text");
    const p = plan([stage]);
    expect(p.items.filter((f) => f.label === "Stage")).toHaveLength(1);
    expect(p.items.find((f) => f.key === stage.key)).toEqual(stage);
    expect(p.kept).toContainEqual({ label: "Stage", note: "‘Stage’ is a text field, so it stays as it is. The board needs Stage to be a select or status field." });
    expect(raiseFieldsOf(p.items).setUp).toBe(false);
    expect(p.addFields).toHaveLength(9);
  });

  it("doesn't add back a field or an option the team archived", () => {
    const tier = field("fld_oldtier00001", "Tier", "select", { options: [opt("opt_tiera001", "A")], archivedAt: at });
    const stage = field("fld_ownstage0003", "Stage", "status", { options: [opt("opt_research", "Research"), opt("opt_replied1", "Replied", at)] });
    const p = plan([tier, stage]);
    expect(p.items.filter((f) => f.label === "Tier")).toEqual([tier]);
    expect(p.kept).toContainEqual({ label: "Tier", note: "You archived ‘Tier’, so it stays archived. Bring it back in Data model if you want it." });
    const after = p.items.find((f) => f.key === stage.key)!;
    expect(after.options!.filter((o) => o.label === "Replied")).toEqual([opt("opt_replied1", "Replied", at)]);
    expect(p.kept.map((k) => k.label)).toContain("Replied");
  });

  it("puts Plan to Funds in before Passed when funding follows raising, and Relationship gains Lender and Bank", () => {
    const raised = plan([]).items;
    const p = plan(raised, "funding");
    const stage = p.items.find((f) => f.preset === "raise.stage")!;
    expect(labels(stage)).toEqual([
      "Research",
      "Contacted",
      "Replied",
      "First meeting",
      "Next meeting",
      "Diligence",
      "Term sheet",
      "Committed (a promise)",
      "Money in",
      "Plan",
      "Applied",
      "Decision",
      "Funds in",
      "Passed",
    ]);
    expect(labels(p.items.find((f) => f.preset === "raise.relationship"))).toEqual(["Investor", "Advisor", "Accelerator", "Lender", "Bank"]);
    expect(p.addFields).toEqual([]);
    expect(p.added).toEqual({ fields: 0, options: 6 });
    expect(raiseFieldsOf(p.items).kinds).toEqual(["raising", "funding"]);
  });

  it("sets up a plant shop's bank loan on its own", () => {
    const p = plan([], "funding");
    expect(labels(p.items.find((f) => f.preset === "raise.stage"))).toEqual(["Plan", "Applied", "Decision", "Funds in", "Passed"]);
    expect(raiseFieldsOf(p.items).kinds).toEqual(["funding"]);
  });

  it("makes Cheque in the currency asked, and keeps the team's own Cheque in its own", () => {
    expect(plan([], "raising", "EUR").items.find((f) => f.preset === "raise.cheque")!.currency).toBe("EUR");
    const own = field("fld_owncheque001", "Cheque size", "currency", { currency: "USD" });
    const p = plan([own], "raising", "GBP");
    expect(p.items.find((f) => f.key === own.key)).toMatchObject({ currency: "USD", preset: "raise.cheque", label: "Cheque size" });
    expect(p.kept).toContainEqual({ label: "Cheque size", note: "‘Cheque size’ keeps its amounts in USD." });
  });

  it("answers field_list_full past a cap", () => {
    const full = Array.from({ length: FIELD_LIMITS.liveFields - 2 }, (_, i) => field(`fld_${String(i).padStart(12, "a")}`.slice(0, 16), `Field ${i}`, "text"));
    expect(planRaiseSetup(full, "raising", { currency: "GBP", nowIso: NOW, userId: null, ...ids() })).toEqual({ ok: false, error: "field_list_full" });
    const reasons = field("fld_ownreason001", "Pass reason", "select", { options: Array.from({ length: 40 }, (_, i) => opt(`opt_${String(i).padStart(8, "r")}`.slice(0, 12), `Reason ${i}`)) });
    expect(planRaiseSetup([reasons], "raising", { currency: "GBP", nowIso: NOW, userId: null, ...ids() })).toEqual({ ok: false, error: "field_list_full" });
  });
});

describe("applyRaiseSetup", () => {
  it("saves one version with the message, and a second press writes nothing", async () => {
    const r = await applyRaiseSetup(admin, { kit: "raising", currency: "GBP", by, nowIso: NOW, ...ids() }, db);
    if (!r.ok) throw new Error(r.error);
    expect(r.rev).toBe(1);
    expect(r.message).toBe("Added 10 fields and 39 options.");
    expect(versions(db)).toHaveLength(1);
    expect(versions(db)[0]).toMatchObject({ message: "Set up for raising: added 10 fields and 39 options", source: "editor", by });
    const list = await readFieldList(admin, "person", db);
    expect(list.items).toHaveLength(10);
    expect(list.items.every((f) => typeof f.preset === "string")).toBe(true);

    const again = await applyRaiseSetup(admin, { kit: "raising", currency: "GBP", by, nowIso: NOW, ...ids() }, db);
    if (!again.ok) throw new Error(again.error);
    expect(again.plan.nothing).toBe(true);
    expect(again.message).toBe("Everything is already here. Nothing was added.");
    expect(versions(db)).toHaveLength(1);
  });

  it("names what it used in the version's message", async () => {
    await commitSettingsChange(admin, { subject: "fields:person", baseRev: 0, value: { items: [field("fld_ownstage0004", "Stage", "status", { options: [opt("opt_research", "Research")] })] }, by, source: "editor" }, db);
    const r = await applyRaiseSetup(admin, { kit: "raising", currency: "GBP", by, nowIso: NOW, ...ids() }, db);
    if (!r.ok) throw new Error(r.error);
    expect(versions(db).find((v) => v.rev === 2)!.message).toBe("Set up for raising: added 9 fields and 38 options, and used your Stage");
  });

  it("plans again from the list as it is when someone saved at the same moment", async () => {
    db.onBeforeCommit = async () => {
      await saveFieldListChange(admin, "person", { baseRev: 0, change: { op: "add", label: "Notes", type: "text" }, by, newFieldId: () => "fld_notes0000001" }, db);
    };
    const r = await applyRaiseSetup(admin, { kit: "raising", currency: "GBP", by, nowIso: NOW, ...ids() }, db);
    if (!r.ok) throw new Error(r.error);
    expect(r.rev).toBe(2);
    const list = await readFieldList(admin, "person", db);
    expect(list.items.map((f) => f.label)).toEqual(["Notes", "Relationship", "Firm", "Tier", "Cheque", "Route in", "Last touch", "Next step", "Next step date", "Stage", "Pass reason"]);
  });

  it("answers fields_changed after three tries", async () => {
    let k = 0;
    const busy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "runTransaction") {
          return async (fn: Parameters<FakeFirestore["runTransaction"]>[0]) => {
            k += 1;
            await saveFieldListChange(admin, "person", { baseRev: k - 1, change: { op: "add", label: `Notes ${k}`, type: "text" }, by }, target);
            return target.runTransaction(fn);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(await applyRaiseSetup(admin, { kit: "raising", currency: "GBP", by, nowIso: NOW }, busy)).toEqual({ ok: false, error: "fields_changed" });
  });

  it("never touches another brand's list", async () => {
    await saveFieldListChange(other, "person", { baseRev: 0, change: { op: "add", label: "Stage", type: "text" }, by }, db);
    await applyRaiseSetup(admin, { kit: "raising", currency: "GBP", by, nowIso: NOW, ...ids() }, db);
    expect((await readFieldList(other, "person", db)).items.map((f) => f.label)).toEqual(["Stage"]);
    expect(versions(db, "ten_b")).toHaveLength(1);
  });
});

describe("the setup requests", () => {
  const loadTenant = async () => ({ id: "ten_a", timeZone: "Europe/Paris", businessProfile: { answers: { run: "shop" } } }) as never;

  it("preview the funding kit first for a shop, in the time zone's currency, and write nothing", async () => {
    const r = await setupPreviewRequest(admin, {}, { db, loadTenant, nowIso: NOW });
    expect(r.status).toBe(200);
    const body = r.body as { kit: string; currency: string; firstKit: string; plan: Pick<SetupPlan, "addFields" | "nothing"> };
    expect(body).toMatchObject({ kit: "funding", currency: "EUR", firstKit: "funding" });
    expect(body.plan.addFields).toHaveLength(10);
    expect(versions(db)).toHaveLength(0);
    const raising = await setupPreviewRequest(admin, { kit: "raising", currency: "USD" }, { db, loadTenant, nowIso: NOW });
    expect(raising.body).toMatchObject({ kit: "raising", currency: "USD" });
    expect((await setupPreviewRequest(admin, { kit: "loan" }, { db, loadTenant })).status).toBe(400);
    expect((await setupPreviewRequest(admin, { currency: "pounds" }, { db, loadTenant })).status).toBe(400);
  });

  it("press, then press again for Everything is already here", async () => {
    const first = await setupRequest(admin, { kit: "raising", currency: "GBP" }, { db, loadTenant, nowIso: NOW, ...ids() });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ added: { fields: 10, options: 39 }, adopted: [], rev: 1, boardHref: "/admin/crm?tab=investors" });
    const second = await setupRequest(admin, { kit: "raising" }, { db, loadTenant, nowIso: NOW, ...ids() });
    expect(second.body).toMatchObject({ added: { fields: 0, options: 0 }, message: "Everything is already here. Nothing was added.", rev: 1 });
    expect((await setupRequest(admin, { kit: "raising", extra: 1 }, { db, loadTenant })).status).toBe(400);
    expect((await setupRequest(admin, null, { db, loadTenant })).status).toBe(400);
  });

  it("pick the first kit from the business profile", () => {
    expect(firstKitOf(null)).toBe("raising");
    expect(firstKitOf({ businessProfile: { answers: { run: "app" } } } as never)).toBe("raising");
    expect(firstKitOf({ businessProfile: { answers: { run: "service" } } } as never)).toBe("funding");
  });
});
