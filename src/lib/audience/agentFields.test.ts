import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { proposeAgentAction, type TenantContext } from "@/lib/tenant";
import { signCanvasContext } from "@/lib/canvas/auth";
import { deterministicContactId } from "@/lib/crm/identifiers";
import { readFieldList, saveFieldListChange, type FieldListChange } from "./fieldList";
import { agentFieldList, agentPersonFields, vizzyFieldsAgentGate } from "./agentFields";
import { PERSON_FIELDS_ACTION } from "./fieldSuggestions";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u_admin", role: "admin" };
const by = { type: "member", id: "u_admin" } as const;
const SAM = deterministicContactId("ten_A", "sam.rivera@example.com");

const ids = {
  plan: "fld_aaaaaaaaaaa1",
  interests: "fld_aaaaaaaaaaa2",
  status: "fld_aaaaaaaaaaa3",
  onboarded: "fld_aaaaaaaaaaa4",
  seats: "fld_aaaaaaaaaaa5",
  mrr: "fld_aaaaaaaaaaa6",
  renewal: "fld_aaaaaaaaaaa7",
  notes: "fld_aaaaaaaaaaa8",
  work: "fld_aaaaaaaaaaa9",
  mobile: "fld_aaaaaaaaaab1",
  site: "fld_aaaaaaaaaab2",
  owner: "fld_aaaaaaaaaab3",
  old: "fld_aaaaaaaaaab4",
};
const optionIds = ["opt_aaaaaaa1", "opt_aaaaaaa2", "opt_aaaaaaa3", "opt_aaaaaaa4", "opt_aaaaaaa5", "opt_aaaaaaa6", "opt_aaaaaaa7", "opt_aaaaaaa8"];

const req = (token?: string) => new Request("https://app.example.com/api/agent/audience/fields", { headers: token ? { "x-canvas-context": token } : {} });

let db: FakeFirestore;

let nextOption = 0;
async function add(id: string, change: FieldListChange) {
  const { rev } = await readFieldList(ctx, "person", db);
  const r = await saveFieldListChange(ctx, "person", { baseRev: rev, change, by, newFieldId: () => id, newOptionId: () => optionIds[nextOption++ % optionIds.length]! }, db);
  if (!r.ok) throw new Error(r.error);
}

beforeEach(async () => {
  __resetRateLimitState();
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-only-canvas-key");
  db = new FakeFirestore();
  nextOption = 0;
  await add(ids.plan, { op: "add", label: "Plan", type: "select", options: ["Starter", "Rivera"] });
  await add(ids.interests, { op: "add", label: "Interests", type: "multi_select", options: ["Analytics", "Exports"] });
  await add(ids.status, { op: "add", label: "Status", type: "status", options: ["Trial", "Paying"] });
  await add(ids.onboarded, { op: "add", label: "Onboarded", type: "checkbox" });
  await add(ids.seats, { op: "add", label: "Seats", type: "number" });
  await add(ids.mrr, { op: "add", label: "Monthly revenue", type: "currency", currency: "GBP" });
  await add(ids.renewal, { op: "add", label: "Renewal date", type: "date" });
  await add(ids.notes, { op: "add", label: "Notes", type: "text" });
  await add(ids.work, { op: "add", label: "Work email", type: "email" });
  await add(ids.mobile, { op: "add", label: "Mobile", type: "phone" });
  await add(ids.site, { op: "add", label: "Website", type: "link" });
  await add(ids.owner, { op: "add", label: "Owner", type: "team_member" });
  await add(ids.old, { op: "add", label: "Old tier", type: "number" });
  await add(ids.old, { op: "archive", key: ids.old });
  // Someone who only joined a launch: no product, no lifecycle brief.
  db.seed("contacts", SAM, {
    tenantId: "ten_A",
    contactKey: "sam.rivera@example.com",
    email: "sam.rivera@example.com",
    firstName: "Sam",
    lastName: "Rivera",
    campaigns: [{ campaignId: "cmp_1", status: "verified_active" }],
    memberOf: ["all", "launch:cmp_1"],
    fields: {
      [ids.plan]: "opt_aaaaaaa2",
      [ids.interests]: ["opt_aaaaaaa3", "opt_aaaaaaa4"],
      [ids.onboarded]: true,
      [ids.seats]: 12,
      [ids.mrr]: 1250,
      [ids.renewal]: "2027-03-01",
      [ids.notes]: "Met Sam at the expo, call on Friday",
      [ids.work]: "sam@work.example.com",
      [ids.mobile]: "+44 7700 900123",
      [ids.site]: "https://sam.example.com",
      [ids.owner]: "u_admin",
      [ids.old]: 3,
    },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("the gate on Vizzy's field routes", () => {
  it("answers unavailable while off, needs the signing key and a token, and takes the brand from the token", () => {
    const token = signCanvasContext(ctx);
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "false");
    expect(vizzyFieldsAgentGate(req(token))).toMatchObject({ ok: false, result: { status: 503, body: { error: "unavailable" } } });
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    expect(vizzyFieldsAgentGate(req(token))).toMatchObject({ ok: false, result: { status: 503 } });
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
    expect(vizzyFieldsAgentGate(req())).toMatchObject({ ok: false, result: { status: 401 } });
    expect(vizzyFieldsAgentGate(req("forged.token"))).toMatchObject({ ok: false, result: { status: 401 } });
    expect(vizzyFieldsAgentGate(req(token))).toMatchObject({ ok: true, ctx: { tenantId: "ten_A", role: "admin" } });
    vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "");
    expect(vizzyFieldsAgentGate(req(token))).toMatchObject({ ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } });
  });
});

describe("the field list Vizzy reads", () => {
  it("has only the seven types in use, with their options and no values", async () => {
    const r = await agentFieldList(ctx, db);
    expect(r.status).toBe(200);
    const body = r.body as { fields: Array<{ id: string; type: string; options?: unknown[] }> };
    expect(body.fields.map((f) => f.type)).toEqual(["select", "multi_select", "status", "checkbox", "number", "currency", "date"]);
    expect(body.fields.find((f) => f.id === ids.plan)?.options).toEqual([
      { id: "opt_aaaaaaa1", label: "Starter" },
      { id: "opt_aaaaaaa2", label: "Rivera" },
    ]);
    expect(JSON.stringify(body)).not.toContain(ids.old);
    expect(body.fields.find((f) => f.id === ids.mrr)).toMatchObject({ currency: "GBP" });
  });
});

describe("one person's fields for Vizzy", () => {
  it("serves someone who only joined a launch, with values of the seven types only", async () => {
    const r = await agentPersonFields(ctx, SAM, db);
    expect(r.status).toBe(200);
    const body = r.body as { personId: string; fields: Array<{ id: string; value: unknown; text: string | null }>; waiting: string[] };
    expect(body.personId).toBe(SAM);
    const byId = Object.fromEntries(body.fields.map((f) => [f.id, f]));
    expect(byId[ids.seats]).toMatchObject({ value: 12, text: "12" });
    expect(byId[ids.mrr]).toMatchObject({ value: 1250, text: "12.50 GBP" });
    expect(byId[ids.renewal]).toMatchObject({ value: "2027-03-01", text: "2027-03-01" });
    expect(byId[ids.onboarded]).toMatchObject({ value: true, text: "Yes" });
    expect(byId[ids.interests]).toMatchObject({ value: ["opt_aaaaaaa3", "opt_aaaaaaa4"], text: "Analytics, Exports" });
    expect(byId[ids.status]).toMatchObject({ value: null, text: null });
    for (const hidden of [ids.notes, ids.work, ids.mobile, ids.site, ids.owner, ids.old]) expect(byId[hidden]).toBeUndefined();
    const text = JSON.stringify(body);
    for (const never of ["expo", "work.example.com", "7700", "sam.example.com", "u_admin", "sam.rivera", "Sam"]) expect(text).not.toContain(never);
  });

  it("scrubs their name out of what it sends, even from an option's label", async () => {
    const body = (await agentPersonFields(ctx, SAM, db)).body as { fields: Array<{ id: string; text: string | null; options?: Array<{ label: string }> }> };
    const plan = body.fields.find((f) => f.id === ids.plan)!;
    expect(plan.text).toBe("[name]");
    expect(plan.options?.map((o) => o.label)).toEqual(["Starter", "[name]"]);
  });

  it("finds nobody for an id that isn't a person's, or a person who isn't there", async () => {
    expect((await agentPersonFields(ctx, "pu_123", db)).status).toBe(404);
    expect((await agentPersonFields(ctx, deterministicContactId("ten_A", "nobody@example.com"), db)).body).toEqual({ error: "person_not_found" });
    expect((await agentPersonFields({ ...ctx, tenantId: "ten_B" }, SAM, db)).status).toBe(404);
  });

  it("lists the fields that already have a suggestion waiting", async () => {
    const at = new Date().toISOString();
    await proposeAgentAction(
      ctx,
      {
        dedupeKey: `${PERSON_FIELDS_ACTION}|t1`,
        agent: "vizzy",
        action: PERSON_FIELDS_ACTION,
        target: { type: "person", id: SAM },
        personId: SAM as `ct_${string}`,
        proposal: { fields: { [ids.seats]: 15 } },
        basis: { fields: { [ids.seats]: 12 } },
        fieldIds: [ids.seats],
        signals: [],
        review: null,
        requestedBy: by,
        expiresAt: new Date(Date.parse(at) + 30 * 86_400_000).toISOString(),
        at,
      },
      { db },
    );
    const body = (await agentPersonFields(ctx, SAM, db)).body as { waiting: string[] };
    expect(body.waiting).toEqual([ids.seats]);
  });

  it("is rate limited", async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await agentPersonFields(ctx, SAM, db)).status;
    expect(last).toBe(429);
  });
});
