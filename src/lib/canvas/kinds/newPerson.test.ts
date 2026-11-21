import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant";
import { deterministicContactId } from "@/lib/crm/identifiers";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { saveFieldListChange } from "@/lib/audience/fieldList";
import { NEW_PERSON_ACTION, readNewPersonDraft } from "@/lib/audience/personDrafts";
import type { AgentActionId } from "@/lib/types/agentAction";
import { authorNewPerson } from "./newPerson";
import { getCanvasKind } from "../registry";

const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u_admin", role: "admin" };
const member: TenantContext = { ...admin, userId: "u_member", role: "member" };
const by = { type: "member", id: "u_admin" } as const;
const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const PLAN = "fld_fffffffffff1";
const NOTES = "fld_fffffffffff2";
const TITLE = "fld_fffffffffff3";
const SAM = deterministicContactId("ten_A", "sam.okoro@example.com");

let db: FakeFirestore;
/** Whether text fields an admin let Vizzy read are on. */
let textFields = false;
const author = (fields: Record<string, unknown>, ctx: TenantContext = admin, nowMs = T0) =>
  authorNewPerson({ ctx, input: { kind: "new_person", action: "save_draft", ...fields }, brief: "" }, { db, nowMs, textFields });

beforeEach(async () => {
  __resetRateLimitState();
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_ADD_PERSON_ENABLED", "AUDIENCE_VIZZY_ADD_PERSON_ENABLED"]) vi.stubEnv(k, "true");
  db = new FakeFirestore();
  textFields = false;
  let o = 0;
  await saveFieldListChange(admin, "person", { baseRev: 0, change: { op: "add", label: "Plan", type: "select", options: ["Starter", "Pro"] }, by, newFieldId: () => PLAN, newOptionId: () => ["opt_ffffff01", "opt_ffffff02"][o++]! }, db);
  await saveFieldListChange(admin, "person", { baseRev: 1, change: { op: "add", label: "Notes", type: "text" }, by, newFieldId: () => NOTES }, db);
  await saveFieldListChange(admin, "person", { baseRev: 2, change: { op: "add", label: "Job Title", type: "text", vizzyReads: true }, by, newFieldId: () => TITLE }, db);
});
afterEach(() => vi.unstubAllEnvs());

describe("the new_person kind", () => {
  it("is registered", () => {
    expect(getCanvasKind("new_person")?.label).toMatch(/New person/);
  });

  it("answers unavailable while off, and is for admins only", async () => {
    vi.stubEnv("AUDIENCE_VIZZY_ADD_PERSON_ENABLED", "false");
    expect(await author({ email: "sam.okoro@example.com" })).toMatchObject({ ok: false, status: 503, error: "unavailable" });
    vi.stubEnv("AUDIENCE_VIZZY_ADD_PERSON_ENABLED", "true");
    vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "false");
    expect(await author({ email: "sam.okoro@example.com" })).toMatchObject({ ok: false, status: 503 });
    vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "true");
    expect(await author({ email: "sam.okoro@example.com" }, member)).toMatchObject({ ok: false, status: 403 });
    expect(await author({ email: "sam.okoro@example.com" }, { ...admin, role: undefined })).toMatchObject({ ok: false, status: 403 });
  });

  it("can never record consent", async () => {
    expect(await author({ email: "sam.okoro@example.com", agreed: { how: "in_person" } })).toMatchObject({ ok: false, status: 400, error: "consent_not_allowed" });
    expect(await author({ email: "sam.okoro@example.com", consent: true })).toMatchObject({ ok: false, status: 400 });
    expect(db.dump("agent_actions")).toEqual([]);
  });

  it("saves the details as a draft for 7 days, keyed to the person they'd be, with a link that holds only its id", async () => {
    const r = await author({ email: " Sam.Okoro@Example.com ", firstName: "Sam", lastName: "Okoro", fields: { plan: "pro", Notes: "Met at the expo", Seats: 3 } });
    if (!r.ok) throw new Error(r.error);
    expect(r.url).toBe(`/admin/crm?draft=${r.id}`);
    expect(r.card).toMatchObject({ kind: "new_person", title: "New person, filled in", stats: [{ label: "field", value: 1 }], cta: "Open the form" });
    expect(JSON.stringify(r.card)).not.toMatch(/Sam|Okoro|example\.com/);
    // Text fields and unknown names are left for the admin to type.
    expect(r.warnings).toHaveLength(2);
    const action = await getAgentAction(admin, r.id as AgentActionId, { db });
    expect(action).toMatchObject({
      action: NEW_PERSON_ACTION,
      state: "proposed",
      personId: SAM,
      target: { type: "person", id: SAM },
      proposal: { person: { email: "sam.okoro@example.com", phone: null, firstName: "Sam", lastName: "Okoro" }, fields: { [PLAN]: "opt_ffffff02" } },
      fieldIds: [PLAN],
      clearDetailsOnClose: true,
      review: { kind: "person_suggestion", href: `/admin/crm?draft=${r.id}` },
      expiresAt: new Date(T0 + 7 * 86_400_000).toISOString(),
    });
    expect(db.raw("contacts", SAM)).toBeUndefined();
    expect(await readNewPersonDraft(admin, r.id, { db, nowMs: T0 })).toMatchObject({ email: "sam.okoro@example.com", firstName: "Sam", fields: { [PLAN]: "opt_ffffff02" } });
    expect(await readNewPersonDraft(admin, r.id, { db, nowMs: T0 + 8 * 86_400_000 })).toBeNull();
  });

  it("fills in a text field an admin let Vizzy read, only while text fields are on", async () => {
    const off = await author({ email: "sam.okoro@example.com", fields: { "Job Title": "Head of Sales" } });
    if (!off.ok) throw new Error(off.error);
    expect(off.warnings).toHaveLength(1);
    expect(off.card).toMatchObject({ stats: [{ label: "fields", value: 0 }] });
    textFields = true;
    const r = await author({ email: "kim.lee@example.com", fields: { "job title": "Head of Sales", Notes: "Met at the expo" } });
    if (!r.ok) throw new Error(r.error);
    // Notes, which nobody ticked, is left for the admin to type.
    expect(r.warnings).toHaveLength(1);
    expect(await getAgentAction(admin, r.id as AgentActionId, { db })).toMatchObject({ proposal: { fields: { [TITLE]: "Head of Sales" } }, fieldIds: [TITLE] });
  });

  it("points at the person already holding the address, and drafts nothing", async () => {
    db.seed("contacts", SAM, { tenantId: "ten_A", contactKey: "sam.okoro@example.com", email: "sam.okoro@example.com" });
    const r = await author({ email: "sam.okoro@example.com", firstName: "Samuel" });
    expect(r).toMatchObject({ ok: true, status: "existing", url: `/admin/crm/people/${SAM}`, card: { title: "Already in People" } });
    expect(db.dump("agent_actions")).toEqual([]);
  });

  it("refuses a request with neither an address nor a phone, or a bad one", async () => {
    expect(await author({ firstName: "Sam" })).toMatchObject({ ok: false, status: 400, error: "email_or_phone" });
    expect(await author({ email: "not an address" })).toMatchObject({ ok: false, status: 400, error: "invalid_email" });
    expect(await author({ phone: "call me" })).toMatchObject({ ok: false, status: 400, error: "invalid_phone" });
  });

  it("answers with the draft waiting for the same details, and replaces it for new ones", async () => {
    const first = await author({ phone: "+44 7700 900456", firstName: "Kim" });
    const again = await author({ phone: "+44 7700 900456", firstName: "Kim" });
    if (!first.ok || !again.ok) throw new Error("not saved");
    expect(again.id).toBe(first.id);
    const newer = await author({ phone: "+44 7700 900456", firstName: "Kim", lastName: "Lee" });
    if (!newer.ok) throw new Error("not saved");
    expect(newer.id).not.toBe(first.id);
    expect(await getAgentAction(admin, first.id as AgentActionId, { db })).toMatchObject({ state: "declined", declined: { reason: "superseded" }, proposal: null });
  });

  it("is rate limited", async () => {
    let last: unknown;
    for (let i = 0; i < 12; i++) last = await author({ email: `person${i}@example.com` });
    expect(last).toMatchObject({ ok: false, status: 429 });
  });
});
