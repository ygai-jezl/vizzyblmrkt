import { vi } from "vitest";
import { commitSettingsChange, forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { readFieldList, saveFieldListChange } from "@/lib/audience/fieldList";
import { createLifecycleJourney, publishLifecycleJourney, saveLifecycleDraft } from "@/lib/lifecycle/service";
import { CONNECTION_ID, ctx as lifecycleCtx, seedWorld, STEPS, TENANT_ID } from "@/lib/lifecycle/testing/fixtures";
import type { UserLookup } from "@/lib/team/names";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import { changeSavedView, createSavedView, removeSavedView } from "@/lib/views/savedViews";
import { emptyView, type ViewDefinition } from "@/lib/views/types";

/**
 * A brand with something of every kind in its history, for the settings history tests: People and
 * Company fields, a journey published twice and edited since, a product catalog with three
 * versions (the first from before history) and a shared connection given by an owner. Made-up
 * people at example.com only.
 */

export { CONNECTION_ID, TENANT_ID };

/** Maya, an admin on the team. */
export const ctx: TenantContext = { ...lifecycleCtx, userId: "usr_maya", email: "maya@example.com" };
export const member: TenantContext = { ...ctx, userId: "usr_tom", role: "member", email: "tom@example.com" };
export const other: TenantContext = { tenantId: "ten_other", region: "eu", source: "idtoken", role: "admin", userId: "usr_maya" };

/** Names Firebase Auth would give: Maya and Tom are on the team; Sam has left; Priya owns the organisation, with no row. */
export const lookup: UserLookup = async (uids) =>
  [
    { uid: "usr_maya", displayName: "Maya Chen", email: "maya@example.com" },
    { uid: "usr_tom", displayName: null, email: "tom@example.com" },
    { uid: "usr_sam", displayName: "Sam Okafor", email: "sam@example.com" },
    { uid: "usr_priya", displayName: "Priya Shah", email: "priya@example.com" },
  ].filter((u) => uids.includes(u.uid));

const at = (day: number, hour = 10) => `2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
export const T = at;

/** The switches every kind needs, on. */
export function switchesOn(): void {
  for (const n of [
    "SETTINGS_HISTORY_ENABLED",
    "AUDIENCE_PERSON_LINKS_ENABLED",
    "AUDIENCE_ONE_VIEW_ENABLED",
    "ONTOLOGY_PERSON_IDS_ENABLED",
    "AUDIENCE_FIELDS_ENABLED",
    "NEXT_PUBLIC_LIFECYCLE_ENABLED",
    "CATALOG_HISTORY_ENABLED",
    "CONNECTORS_ENABLED",
    "PLANS_ENABLED",
    "CONNECTORS_SHARING_ENABLED",
  ]) {
    vi.stubEnv(n, "true");
  }
}

const catalog = (steps: typeof STEPS): ConnectionCatalog => ({ events: [], traits: [{ key: "plan", type: "string", label: "Plan", description: "" }], onboardingSteps: steps, glossary: [] }) as unknown as ConnectionCatalog;

export interface World {
  db: FakeFirestore;
  journeyId: string;
  /** The Tier field's key and its options' ids. */
  tier: string;
}

/**
 * Fields (People v1 to v4, Company v1), a journey (v1 by Sam on the 3rd, v2 by Maya on the 6th, a
 * draft edit on the 8th), catalog versions 1 (before history), 2 (Sam, 4th) and 3 (Maya, 7th), and
 * a shared connection given by Priya on the 5th.
 */
export async function buildWorld(): Promise<World> {
  const db = new FakeFirestore();
  seedWorld(db);
  db.seed("tenants", TENANT_ID, { ...(db.raw("tenants", TENANT_ID) ?? {}), organisationId: "org_fernhill" });
  db.seed("organisations", "org_fernhill", { name: "Fernhill Group", plan: "ultra", planSince: at(1), brandIds: [TENANT_ID], ownerIds: ["usr_priya"], createdBy: "usr_priya", createdAt: at(1), updatedAt: at(1) });
  for (const [id, role] of [["usr_maya", "admin"], ["usr_tom", "member"]] as const) {
    await forTenant(ctx, db).members.create(`${TENANT_ID}_${id}`, { userId: id, role, joinedAt: at(1) });
  }
  const maya = { type: "member", id: "usr_maya" } as const;
  let n = 0;
  const fld = () => `fld_${String((n += 1)).padStart(12, "0")}`;
  let o = 0;
  const opt = () => `opt_${String((o += 1)).padStart(8, "0")}`;
  // People fields: v1 Tier (Gold, Silver), v2 Delivery day, v3 Bronze added, v4 Delivery day archived.
  await saveFieldListChange(ctx, "person", { baseRev: 0, change: { op: "add", label: "Tier", type: "select", options: ["Gold", "Silver"] }, by: maya, nowIso: at(2, 9), newFieldId: fld, newOptionId: opt }, db);
  await saveFieldListChange(ctx, "person", { baseRev: 1, change: { op: "add", label: "Delivery day", type: "text" }, by: maya, nowIso: at(2, 11), newFieldId: fld, newOptionId: opt }, db);
  await saveFieldListChange(ctx, "person", { baseRev: 2, change: { op: "add_option", key: "fld_000000000001", label: "Bronze" }, by: { type: "member", id: "usr_sam" }, nowIso: at(4, 9), newOptionId: opt }, db);
  await saveFieldListChange(ctx, "person", { baseRev: 3, change: { op: "archive", key: "fld_000000000002" }, by: maya, nowIso: at(9) }, db);
  await saveFieldListChange(ctx, "company", { baseRev: 0, change: { op: "add", label: "Region", type: "text" }, by: maya, nowIso: at(2, 12), newFieldId: fld }, db);

  // A journey published twice, then edited.
  const created = await createLifecycleJourney(ctx, { name: "Welcome to the greenhouse", connectionId: CONNECTION_ID, template: "product_onboarding" }, { db, nowMs: Date.parse(at(1)) });
  if (!created.ok) throw new Error(created.error);
  const journeyId = created.value.journey.id;
  await publishLifecycleJourney({ ...ctx, userId: "usr_sam" }, journeyId, { db, nowMs: Date.parse(at(3)) });
  const draft = structuredClone(created.value.journey.draft);
  draft.pools[0]!.items[0]!.subject = "Welcome, plant lover";
  await saveLifecycleDraft(ctx, journeyId, draft, { db, nowMs: Date.parse(at(5)) });
  await publishLifecycleJourney(ctx, journeyId, { db, nowMs: Date.parse(at(6)) });
  draft.pools[0]!.items[0]!.subject = "Unpublished words";
  await saveLifecycleDraft(ctx, journeyId, draft, { db, nowMs: Date.parse(at(8)) });

  // Catalog versions: 1 from before history, 2 adds a step (Sam), 3 renames one (Maya). The product is on 3.
  const steps2 = [...STEPS, { id: "book_visit", label: "Book a visit", url: "https://app.example.com/book", order: 3 }];
  const steps3 = steps2.map((s) => (s.id === "run_audit" ? { ...s, label: "First visit" } : s));
  const revisions = forTenant(ctx, db).catalogRevisions;
  await revisions.create(`${CONNECTION_ID}_r000001`, { connectionId: CONNECTION_ID, rev: 1, catalog: catalog(STEPS), savedAt: at(1, 8), savedBy: null, source: "before_history", changes: [] });
  await revisions.create(`${CONNECTION_ID}_r000002`, { connectionId: CONNECTION_ID, rev: 2, catalog: catalog(steps2), savedAt: at(4), savedBy: "usr_sam", source: "editor", changes: ["Added step ‘Book a visit’"] });
  await revisions.create(`${CONNECTION_ID}_r000003`, { connectionId: CONNECTION_ID, rev: 3, catalog: catalog(steps3), savedAt: at(7), savedBy: "usr_maya", source: "editor", changes: ["Renamed step ‘Run an audit’ to ‘First visit’"] });
  await forTenant(ctx, db).productConnections.update(CONNECTION_ID, { catalog: catalog(steps3), catalogRev: 3 } as never);

  // A part given by Priya, who owns the organisation and has no row on the team.
  await commitSettingsChange(
    ctx,
    {
      subject: "connections:shared",
      baseRev: 0,
      value: { items: [{ key: "p_1", label: "fernhill.example", archivedAt: null, replacedBy: null }] },
      by: { type: "member", id: "usr_priya" },
      source: "editor",
      message: "Gave ‘Google Analytics, fernhill.example’",
      nowIso: at(5, 12),
    },
    db,
  );

  // Another brand's history, which must never show.
  await saveFieldListChange(other, "person", { baseRev: 0, change: { op: "add", label: "Secret", type: "text" }, by: maya, nowIso: at(10) }, db);
  return { db, journeyId, tier: "fld_000000000001" };
}

/** Team views on People, as History's views kind needs them on. */
export function viewsOn(): void {
  vi.stubEnv("CRM_VIEWS_ENABLED", "true");
}

export interface Views {
  /** ‘Wholesale’, renamed ‘Trade buyers’. */
  trade: string;
  /** ‘Gold tier’, archived. */
  gold: string;
  /** Tom's own ‘My repots’, never logged. */
  mine: string;
  /** Wholesale's filters as version 1 saved them, and as version 2 changed them. */
  gold1: ViewDefinition;
  goldSilver2: ViewDefinition;
}

/**
 * Team views (the `views:person` setting), all by Maya: v1 ‘Wholesale’ on the 11th, v2 renames it
 * ‘Trade buyers’ with Silver added to its filter on the 12th, v3 ‘Gold tier’ on the 13th, v4
 * archives Gold tier on the 14th. Tom saves ‘My repots’ for himself on the 15th, which no log keeps.
 */
export async function addTeamViews(w: World): Promise<Views> {
  const fields = (await readFieldList(ctx, "person", w.db)).items;
  let n = 0;
  const newId = () => `viw_${String((n += 1)).padStart(12, "0")}`;
  const tier = (...options: string[]): ViewDefinition => ({ ...emptyView(), filters: [{ on: w.tier, op: "any_of", value: options }], sort: { by: "last_active", dir: "desc" } });
  const gold1 = tier("opt_00000001");
  const goldSilver2 = tier("opt_00000001", "opt_00000002");
  const ok = <R extends { ok: boolean }>(r: R): R => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r;
  };
  const trade = ok(await createSavedView(ctx, { scope: "team", name: "Wholesale", definition: gold1, fields, newId, nowIso: at(11) }, w.db));
  const id = trade.ok ? trade.view.id : "";
  ok(await changeSavedView(ctx, id, { version: 1, name: "Trade buyers", definition: goldSilver2, fields, nowIso: at(12) }, w.db));
  const gold = ok(await createSavedView(ctx, { scope: "team", name: "Gold tier", definition: gold1, fields, newId, nowIso: at(13) }, w.db));
  const goldId = gold.ok ? gold.view.id : "";
  ok(await removeSavedView(ctx, goldId, { version: 1, nowIso: at(14) }, w.db));
  const mine = ok(await createSavedView(member, { scope: "me", name: "My repots", definition: emptyView(), fields, newId, nowIso: at(15) }, w.db));
  return { trade: id, gold: goldId, mine: mine.ok ? mine.view.id : "", gold1, goldSilver2 };
}
