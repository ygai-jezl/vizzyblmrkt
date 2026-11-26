import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant, setRecordFieldValues, type AuditObjectSink, type VerifiedPerson } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { readFieldList, restoreFieldListVersion, saveFieldListChange } from "@/lib/audience/fieldList";
import { deterministicContactId } from "@/lib/crm/identifiers";
import type { Tenant } from "@/lib/types/tenant";
import type { FieldEraseJob } from "@/lib/types/fieldEraseJob";
import { listSettingsVersions } from "./history";
import { checkErase, eraseStatus, fieldEraseJobId, runFieldErase, startFieldCount, startFieldErase, stepFieldEraseJob, type EraseDeps } from "./eraseArchived";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-26T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = iso(NOW - 60 * DAY);
const TENANT = "ten_fernhill";
const ctx: TenantContext = { tenantId: TENANT, region: "eu", source: "idtoken", role: "admin", userId: "usr_sam" };
/** Sam owns the organisation and has an admin row; Maya has a row and owns nothing; Lee owns it but first signed in here, with no row. */
const sam: VerifiedPerson = { userId: "usr_sam", homeTenantId: "ten_home", homeRole: "admin" };
const maya: VerifiedPerson = { userId: "usr_maya", homeTenantId: "ten_home", homeRole: "admin" };
const lee: VerifiedPerson = { userId: "usr_lee", homeTenantId: TENANT, homeRole: "admin" };
const TIER = "fld_000000000001";
const NOTES = "fld_000000000002";
const POT = "fld_000000000003";
const PEOPLE = ["ada", "bo", "cy", "di"].map((n) => deterministicContactId(TENANT, `${n}@example.com`));

class MemorySink implements AuditObjectSink {
  puts: Array<{ path: string; body: Record<string, unknown> }> = [];
  fail = false;
  async put(path: string, body: string) {
    if (this.fail) throw new Error("worm down");
    this.puts.push({ path, body: JSON.parse(body) });
  }
}

const TENANT_DOC = {
  tenantName: "Fernhill Plants",
  rootDomain: "fernhill.example",
  status: "active",
  region: "eu",
  allowedOrigins: [],
  billingTier: "pro",
  ownerId: "usr_sam",
  organisationId: "org_fernhill",
  createdAt: T0,
  updatedAt: T0,
};

let db: FakeFirestore;
let sink: MemorySink;
let clock: number;
const deps = (over: Partial<EraseDeps> = {}): EraseDeps => ({ db, sink, now: () => clock, ...over });

beforeEach(async () => {
  for (const n of ["SETTINGS_HISTORY_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "PLANS_ENABLED", "SETTINGS_ERASE_ENABLED"]) vi.stubEnv(n, "true");
  clock = NOW;
  sink = new MemorySink();
  // Jobs come back with dates as Firestore keeps them.
  db = timestampFirestore(new FakeFirestore(), ["field_erase_jobs"]);
  db.seed("tenants", TENANT, TENANT_DOC);
  db.seed("organisations", "org_fernhill", { name: "Fernhill Group", plan: "ultra", planSince: T0, brandIds: [TENANT], ownerIds: ["usr_sam", "usr_lee"], createdBy: "usr_sam", createdAt: T0, updatedAt: T0 });
  for (const id of ["usr_sam", "usr_maya"]) await forTenant(ctx, db).members.create(`${TENANT}_${id}`, { userId: id, role: "admin", joinedAt: T0 });
  let f = 0;
  let o = 0;
  const by = { type: "member", id: "usr_maya" } as const;
  const fld = () => `fld_${String((f += 1)).padStart(12, "0")}`;
  const opt = () => `opt_${String((o += 1)).padStart(8, "0")}`;
  await saveFieldListChange(ctx, "person", { baseRev: 0, change: { op: "add", label: "Old loyalty tier", type: "select", options: ["Gold", "Silver"] }, by, nowIso: T0, newFieldId: fld, newOptionId: opt }, db);
  await saveFieldListChange(ctx, "person", { baseRev: 1, change: { op: "add", label: "Notes", type: "text" }, by, nowIso: T0, newFieldId: fld }, db);
  await saveFieldListChange(ctx, "person", { baseRev: 2, change: { op: "add", label: "Pot colour", type: "text" }, by, nowIso: T0, newFieldId: fld }, db);
  for (const id of PEOPLE) db.seed("contacts", id, { tenantId: TENANT, memberOf: ["all"], updatedAt: T0 });
  for (const [i, id] of PEOPLE.slice(0, 3).entries()) {
    await setRecordFieldValues(ctx, { object: "person", recordId: id, changes: { [TIER]: i === 0 ? "opt_00000002" : "opt_00000001", [NOTES]: `kept ${i}` }, by, source: "editor", nowIso: T0, nonce: () => `n${i}` }, { db });
  }
  db.seed("agent_actions", "aa_1", { tenantId: TENANT, state: "proposed", fieldIds: [TIER, NOTES], proposal: { fields: { [TIER]: "opt_00000001", [NOTES]: "a note" } } });
  db.seed("agent_actions", "aa_2", { tenantId: TENANT, state: "proposed", fieldIds: [NOTES], proposal: { fields: { [NOTES]: "another" } } });
  await saveFieldListChange(ctx, "person", { baseRev: 3, change: { op: "archive", key: TIER }, by, nowIso: iso(NOW - 41 * DAY) }, db);
  await saveFieldListChange(ctx, "person", { baseRev: 4, change: { op: "archive", key: POT }, by, nowIso: iso(NOW - 12 * DAY) }, db);
});
afterEach(() => vi.unstubAllEnvs());

const tierTarget = { object: "person" as const, fieldId: TIER };
const job = async () => (await forTenant(ctx, db).fieldEraseJobs.getById(fieldEraseJobId(TENANT, "person", TIER))) as FieldEraseJob;
async function finish(id = fieldEraseJobId(TENANT, "person", TIER)) {
  for (let i = 0; i < 20 && (await job()).state === "running"; i += 1) await stepFieldEraseJob(ctx, id, { deadlineMs: clock + 60_000 }, deps());
  return job();
}

describe("who may erase, and when", () => {
  it("is an owner with a real admin row, 30 days after the latest archive, with no hold", async () => {
    expect(await checkErase(ctx, sam, tierTarget, deps())).toMatchObject({ ok: true });
    expect(await checkErase(ctx, maya, tierTarget, deps())).toMatchObject({ ok: false, why: "not_owner" });
    expect(await checkErase(ctx, lee, tierTarget, deps())).toMatchObject({ ok: false, why: "home_only" });
    expect(await checkErase(ctx, null, tierTarget, deps())).toMatchObject({ ok: false, why: "not_admin" });
    expect(await checkErase(ctx, sam, { object: "person", fieldId: POT }, deps())).toMatchObject({ ok: false, why: "too_soon", from: iso(NOW + 18 * DAY) });
    expect(await checkErase(ctx, sam, { object: "person", fieldId: NOTES }, deps())).toMatchObject({ ok: false, why: "not_archived" });
    expect(await checkErase(ctx, sam, { object: "person", fieldId: "fld_000000000099" }, deps())).toMatchObject({ ok: false, why: "field_not_found" });
    const held = { holdFeature: (() => ({ feature: "legal_hold", on: true, reason: "licensed" })) as never };
    expect(await checkErase(ctx, sam, tierTarget, deps({ ...held, holdReader: async () => true }))).toMatchObject({ ok: false, why: "legal_hold" });
    expect(await checkErase(ctx, sam, tierTarget, deps(held))).toMatchObject({ ok: false, why: "legal_hold" });
    expect(await checkErase(ctx, sam, tierTarget, deps({ ...held, holdReader: async () => false }))).toMatchObject({ ok: true });
    vi.stubEnv("SETTINGS_ERASE_ENABLED", "false");
    expect(await checkErase(ctx, sam, tierTarget, deps())).toMatchObject({ ok: false, why: "erase_off" });
  });
});

describe("the count", () => {
  it("counts in the background, writes nothing, and one field has one job however often it is pressed", async () => {
    const before = JSON.stringify(db.dump("contacts"));
    const versions = (await listSettingsVersions(ctx, "fields:person", {}, db)).versions.length;
    expect((await startFieldCount(ctx, sam, tierTarget, deps())).status).toBe(200);
    expect((await startFieldCount(ctx, sam, tierTarget, deps())).body).toMatchObject({ job: { mode: "count", state: "running" } });
    expect(db.dump("field_erase_jobs")).toHaveLength(1);
    const done = await finish();
    expect(done).toMatchObject({ mode: "count", state: "done", counts: { records: 3, events: 3, agentActions: 1 }, startedBy: "usr_sam" });
    expect(JSON.stringify(db.dump("contacts"))).toBe(before);
    expect((await listSettingsVersions(ctx, "fields:person", {}, db)).versions).toHaveLength(versions);
    expect(sink.puts).toEqual([]);
    expect((await startFieldCount(ctx, maya, tierTarget, deps())).status).toBe(403);
  });
});

describe("the erase", () => {
  async function counted() {
    await startFieldCount(ctx, sam, tierTarget, deps());
    await finish();
    clock += 10 * 60_000;
  }

  it("needs a count since the archive and the field's name typed", async () => {
    expect(await startFieldErase(ctx, sam, { ...tierTarget, name: "Old loyalty tier" }, deps())).toEqual({ status: 409, body: { error: "count_first" } });
    await counted();
    expect(await startFieldErase(ctx, sam, { ...tierTarget, name: "old loyalty" }, deps())).toEqual({ status: 400, body: { error: "name_mismatch" } });
    expect((await readFieldList(ctx, "person", db)).items[0]).not.toHaveProperty("erasingSince");
    expect(sink.puts).toEqual([]);
  });

  it("writes nothing when the audit trail can't be written", async () => {
    await counted();
    sink.fail = true;
    expect(await startFieldErase(ctx, sam, { ...tierTarget, name: "Old loyalty tier" }, deps())).toEqual({ status: 503, body: { error: "audit_unavailable" } });
    expect((await readFieldList(ctx, "person", db)).items[0]).not.toHaveProperty("erasingSince");
    expect((await job()).mode).toBe("count");
  });

  it("blanks values, tags, history and suggestions for that field only, resumes from its cursor, and keeps the definition", async () => {
    await counted();
    const events = db.dump("ontology_events").length;
    const r = await startFieldErase(ctx, sam, { ...tierTarget, name: " Old loyalty tier " }, deps());
    expect(r).toMatchObject({ status: 200, body: { job: { mode: "erase", state: "running", counted: { records: 3, events: 3, agentActions: 1 } } } });
    // "initiated" went to the WORM store before anything changed, then the field was marked.
    expect(sink.puts.map((p) => p.body.status)).toEqual(["initiated"]);
    expect((await readFieldList(ctx, "person", db)).items[0]).toMatchObject({ erasingSince: iso(clock) });
    // A tick with no time left leaves it where it was; the next carries on.
    expect(await stepFieldEraseJob(ctx, (await job()).id, { deadlineMs: clock }, deps())).toEqual({ pages: 0, state: "running" });
    const done = await finish();
    expect(done).toMatchObject({ state: "done", counts: { records: 3, events: 3, agentActions: 1 }, leaseUntil: null });

    for (const id of PEOPLE.slice(0, 3)) {
      const c = db.raw("contacts", id) as { fields: Record<string, unknown>; memberOf: string[] };
      expect(c.fields).not.toHaveProperty(TIER);
      expect(c.fields[NOTES]).toMatch(/^kept /);
      expect(c.memberOf.some((t) => t.startsWith(`field:${TIER}:`))).toBe(false);
    }
    const all = db.dump("ontology_events");
    expect(all).toHaveLength(events);
    for (const e of all.filter((x) => x.fieldId === TIER)) expect(e).toMatchObject({ properties: { before: null, after: null }, blankedReason: "field_erased" });
    for (const e of all.filter((x) => x.fieldId === NOTES)) expect((e.properties as { after: unknown }).after).toMatch(/^kept /);
    expect(db.raw("agent_actions", "aa_1")).toMatchObject({ fieldIds: [NOTES], proposal: { fields: { [TIER]: null, [NOTES]: "a note" } } });
    expect(db.raw("agent_actions", "aa_2")).toMatchObject({ fieldIds: [NOTES] });

    const tier = (await readFieldList(ctx, "person", db)).items[0]!;
    expect(tier).toMatchObject({ archivedAt: iso(NOW - 41 * DAY), erasedBy: "usr_sam" });
    expect(tier).not.toHaveProperty("erasingSince");
    expect(tier.options!.map((o) => o.label)).toEqual(["Gold", "Silver"]);
    expect((await listSettingsVersions(ctx, "fields:person", {}, db)).versions.slice(0, 2).map((v) => [v.source, v.message])).toEqual([
      ["erase", "Erased the values of ‘Old loyalty tier’"],
      ["erase", "Started erasing the values of ‘Old loyalty tier’"],
    ]);

    // The audit: initiated, then completed, with counts only.
    expect(sink.puts.map((p) => p.body.status)).toEqual(["initiated", "completed"]);
    expect(sink.puts[1]!.body).toMatchObject({ action: "field.erase", actorUid: "usr_sam", tenantId: TENANT, region: "eu", fieldId: TIER, object: "person", counts: { records: 3, events: 3, agentActions: 1 } });
    expect(sink.puts[0]!.path).toMatch(/^audit\/field-erase\//);
    expect(JSON.stringify(sink.puts)).not.toMatch(/Gold|Silver|loyalty|@/);
    expect(db.dump("audit_events")).toHaveLength(2);

    // Once erased it can't be erased again, until it is brought back and archived once more.
    expect(await checkErase(ctx, sam, tierTarget, deps())).toMatchObject({ ok: false, why: "already_erased" });
  });

  it("can be erased again after a restore brings it back and it is archived 30 days", async () => {
    await counted();
    await startFieldErase(ctx, sam, { ...tierTarget, name: "Old loyalty tier" }, deps());
    await finish();
    const list = await readFieldList(ctx, "person", db);
    await restoreFieldListVersion(ctx, "person", { rev: 3, baseRev: list.rev, by: { type: "member", id: "usr_maya" }, nowIso: iso(clock) }, db);
    const back = (await readFieldList(ctx, "person", db)).items[0]!;
    expect(back.archivedAt ?? null).toBeNull();
    expect(back.erasedAt).toBeTruthy();
    const again = await readFieldList(ctx, "person", db);
    await saveFieldListChange(ctx, "person", { baseRev: again.rev, change: { op: "archive", key: TIER }, by: { type: "member", id: "usr_maya" }, nowIso: iso(clock + DAY) }, db);
    expect(await checkErase(ctx, sam, tierTarget, deps())).toMatchObject({ ok: false, why: "too_soon" });
    clock += 32 * DAY;
    expect(await checkErase(ctx, sam, tierTarget, deps())).toMatchObject({ ok: true });
    // The old count no longer stands: it was made before this archive.
    expect(await startFieldErase(ctx, sam, { ...tierTarget, name: "Old loyalty tier" }, deps())).toEqual({ status: 409, body: { error: "count_first" } });
  });

  it("stops if the field is in use again, and fails after five failed steps, writing failed to the audit", async () => {
    await counted();
    await startFieldErase(ctx, sam, { ...tierTarget, name: "Old loyalty tier" }, deps());
    // People can't be read: each step fails.
    const broken = failingFirestore(db, { collections: ["contacts"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 5; i += 1) await stepFieldEraseJob(ctx, (await job()).id, { deadlineMs: clock + 60_000 }, deps({ db: broken }));
    warn.mockRestore();
    expect(await job()).toMatchObject({ state: "failed", failures: 5, error: "step_failed" });
    expect(sink.puts.map((p) => p.body.status)).toEqual(["initiated", "failed"]);
    // Still marked, so a move drops its values; pressing Erase values again carries on from the cursor.
    expect((await readFieldList(ctx, "person", db)).items[0]).toHaveProperty("erasingSince");
    expect((await startFieldCount(ctx, sam, tierTarget, deps())).body).toMatchObject({ job: { mode: "erase", state: "failed" } });
    expect((await startFieldErase(ctx, sam, { ...tierTarget, name: "Old loyalty tier" }, deps())).body).toMatchObject({ job: { mode: "erase", state: "running" } });
    expect(sink.puts).toHaveLength(2);
    expect(await finish()).toMatchObject({ state: "done" });
  });

  it("says where an erase stands, to the owner and to anyone else", async () => {
    await counted();
    expect((await eraseStatus(ctx, sam, tierTarget, deps())).body).toMatchObject({ allowed: true, countStands: true, job: { mode: "count", state: "done" }, field: { label: "Old loyalty tier", erasing: false } });
    expect(await eraseStatus(ctx, maya, tierTarget, deps())).toEqual({ status: 403, body: { error: "not_owner" } });
    // Before 30 days, an owner is told when.
    expect((await eraseStatus(ctx, sam, { object: "person", fieldId: POT }, deps())).body).toMatchObject({ allowed: false, refused: "too_soon", from: iso(NOW + 18 * DAY) });
  });
});

describe("runFieldErase, the tick's lane", () => {
  const tenants = async () => [{ ...TENANT_DOC, id: TENANT } as unknown as Tenant, { ...TENANT_DOC, id: "ten_gone", status: "suspended" } as unknown as Tenant];

  it("moves running jobs on only while its switch is on; off, a job waits at its cursor, still marked", async () => {
    await startFieldCount(ctx, sam, tierTarget, deps());
    vi.stubEnv("SETTINGS_ERASE_ENABLED", "false");
    expect(await runFieldErase({ deadlineMs: clock + 20_000 }, { ...deps(), listTenants: tenants })).toEqual({ brands: 0, jobs: 0, pages: 0 });
    expect((await job()).state).toBe("running");
    vi.stubEnv("SETTINGS_ERASE_ENABLED", "true");
    const r = await runFieldErase({ deadlineMs: clock + 20_000 }, { ...deps(), listTenants: tenants });
    expect(r).toMatchObject({ brands: 1, jobs: 1 });
    expect((await job()).state).toBe("done");
  });
});
