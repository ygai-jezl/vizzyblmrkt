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

/** The canvas route's stamp with LOOPS_ENABLED off (learning loops step 5). */
const LOOPS_OFF = { unstamped: "loops_off" } as const;

const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u_admin", role: "admin" };
const member: TenantContext = { ...admin, userId: "u_member", role: "member" };
const by = { type: "member", id: "u_admin" } as const;
const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const PLAN = "fld_fffffffffff1";
const NOTES = "fld_fffffffffff2";
const TITLE = "fld_fffffffffff3";
const SAM = deterministicContactId("ten_A", "sam.okoro@example.com");

let db: FakeFirestore;
/** Turns on text fields an admin let Vizzy read (AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED, which needs Vizzy's fields). */
function textFieldsOn(on = true) {
  for (const k of ["AUDIENCE_FIELDS_ENABLED", "AUDIENCE_VIZZY_FIELDS_ENABLED"]) vi.stubEnv(k, "true");
  vi.stubEnv("AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED", on ? "true" : "false");
}
const author = (fields: Record<string, unknown>, ctx: TenantContext = admin, nowMs = T0) =>
  authorNewPerson({ ctx, input: { kind: "new_person", action: "save_draft", ...fields }, made: LOOPS_OFF, brief: "" }, { db, nowMs });

beforeEach(async () => {
  __resetRateLimitState();
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_ADD_PERSON_ENABLED", "AUDIENCE_VIZZY_ADD_PERSON_ENABLED"]) vi.stubEnv(k, "true");
  db = new FakeFirestore();
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

  it("fills in a text field an admin let Vizzy read, only while its switch is on", async () => {
    const off = await author({ email: "sam.okoro@example.com", fields: { "Job Title": "Head of Sales" } });
    if (!off.ok) throw new Error(off.error);
    expect(off.warnings).toHaveLength(1);
    expect(off.card).toMatchObject({ stats: [{ label: "fields", value: 0 }] });
    textFieldsOn();
    const r = await author({ email: "kim.lee@example.com", fields: { "job title": "Head of Sales", Notes: "Met at the expo" } });
    if (!r.ok) throw new Error(r.error);
    // Notes, which nobody ticked, is left for the admin to type.
    expect(r.warnings).toHaveLength(1);
    expect(await getAgentAction(admin, r.id as AgentActionId, { db })).toMatchObject({ proposal: { fields: { [TITLE]: "Head of Sales" } }, fieldIds: [TITLE] });
  });

  it("leaves a drafted text field out of the form once Vizzy may no longer read it", async () => {
    textFieldsOn();
    const r = await author({ email: "kim.lee@example.com", fields: { Plan: "Pro", "Job Title": "Head of Sales" } });
    if (!r.ok) throw new Error(r.error);
    const formFields = async () => (await readNewPersonDraft(admin, r.id, { db, nowMs: T0 }))?.fields;
    expect(await formFields()).toEqual({ [PLAN]: "opt_ffffff02", [TITLE]: "Head of Sales" });
    // An admin unticks Job Title: the admin types it in the form instead.
    await saveFieldListChange(admin, "person", { baseRev: 3, change: { op: "vizzy_reads", key: TITLE, on: false }, by }, db);
    expect(await formFields()).toEqual({ [PLAN]: "opt_ffffff02" });
    // Ticked again, but text fields turned off: the same.
    await saveFieldListChange(admin, "person", { baseRev: 4, change: { op: "vizzy_reads", key: TITLE, on: true }, by }, db);
    expect(await formFields()).toEqual({ [PLAN]: "opt_ffffff02", [TITLE]: "Head of Sales" });
    textFieldsOn(false);
    expect(await formFields()).toEqual({ [PLAN]: "opt_ffffff02" });
  });

  it("leaves out text over 500 characters, or holding a mark the scrubber leaves, with a warning", async () => {
    textFieldsOn();
    const r = await author({ email: "kim.lee@example.com", fields: { "Job Title": "z".repeat(501) } });
    if (!r.ok) throw new Error(r.error);
    expect(r.warnings).toEqual(["That value is too long for Job Title: you can fill in up to 500 characters, and the admin can type it in the form."]);
    expect(r.card).toMatchObject({ stats: [{ label: "fields", value: 0 }] });
    const marked = await author({ email: "ana.ruiz@example.com", fields: { "Job Title": "Assistant to [name]" } });
    if (!marked.ok) throw new Error(marked.error);
    expect(marked.warnings).toEqual(["That value doesn't fit Job Title: the admin can set it in the form."]);
    const fits = await author({ email: "lee.park@example.com", fields: { "Job Title": "q".repeat(500) } });
    if (!fits.ok) throw new Error(fits.error);
    expect(fits.warnings).toEqual([]);
  });

  it("answers too_large for a draft too big to save, and leaves the one waiting in place", async () => {
    textFieldsOn();
    // Twenty five text fields Vizzy may read, each given 500 characters that take 6 bytes each as JSON.
    const big = Array.from({ length: 25 }, (_, i) => `fld_ggggggggg${String(i).padStart(3, "0")}`);
    for (const [i, id] of big.entries()) await saveFieldListChange(admin, "person", { baseRev: 3 + i, change: { op: "add", label: `Long ${i}`, type: "text", vizzyReads: true }, by, newFieldId: () => id }, db);
    const waiting = await author({ email: "sam.okoro@example.com", fields: { "Job Title": "Head of Sales" } });
    if (!waiting.ok) throw new Error(waiting.error);
    const r = await author({ email: "sam.okoro@example.com", fields: Object.fromEntries(big.map((_, i) => [`Long ${i}`, "\u0001".repeat(500)])) });
    expect(r).toMatchObject({ ok: false, status: 400, error: "too_large" });
    expect(await getAgentAction(admin, waiting.id as AgentActionId, { db })).toMatchObject({ state: "proposed" });
  });

  it("points at the person already holding the address, and drafts nothing", async () => {
    db.seed("contacts", SAM, { tenantId: "ten_A", contactKey: "sam.okoro@example.com", email: "sam.okoro@example.com" });
    const r = await author({ email: "sam.okoro@example.com", firstName: "Samuel" });
    // Nothing new was drafted, so the canvas route counts nothing made (decision 20).
    expect(r).toMatchObject({ ok: true, status: "existing", url: `/admin/crm/people/${SAM}`, card: { title: "Already in People" }, saved: "none" });
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
    // The draft already waiting is nothing new to count made (decision 20); one in its place is.
    expect([first.saved, again.saved]).toEqual(["created", "none"]);
    const newer = await author({ phone: "+44 7700 900456", firstName: "Kim", lastName: "Lee" });
    if (!newer.ok) throw new Error("not saved");
    expect(newer.id).not.toBe(first.id);
    expect(newer.saved).toBe("created");
    expect(await getAgentAction(admin, first.id as AgentActionId, { db })).toMatchObject({ state: "declined", declined: { reason: "superseded" }, proposal: null });
  });

  it("is rate limited", async () => {
    let last: unknown;
    for (let i = 0; i < 12; i++) last = await author({ email: `person${i}@example.com` });
    expect(last).toMatchObject({ ok: false, status: 429 });
  });
});
