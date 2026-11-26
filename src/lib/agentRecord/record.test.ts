import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import type { TenantContext } from "@/lib/tenant/types";
import { deleteLaunch } from "@/lib/tenant/launchDeletion";
import type { AuditObjectSink } from "@/lib/tenant/auditSink";
import { expireAgentActions } from "@/lib/tenant/agentActions";
import type { AgentAction } from "@/lib/types/agentAction";
import { closeDraft, closeStyle, openRecordsFor, recordDraft, recordFailures, resetRecordFailures, styleKeyPart, styleRecordId, type RecordDraftInput } from "./record";

// Made-up brands and people.
const A: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_a1", role: "admin" };
const A2: TenantContext = { ...A, source: "idtoken", userId: "usr_a2" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "agent", userId: "usr_b1", role: "admin" };
const T0 = Date.parse("2026-12-01T10:00:00.000Z");
const MIN = 60_000;

const journey = (over: Partial<RecordDraftInput> = {}): RecordDraftInput => ({
  action: "lifecycle_journey.draft",
  draft: { kind: "lifecycle_journey", ref: "lcj_spring" },
  href: "/admin/lifecycle/lcj_spring",
  label: "Spring repotting",
  fingerprint: "aaaaaaaaaaaaaaaa",
  ...over,
});

async function all(db: FakeFirestore, ctx = A): Promise<AgentAction[]> {
  return (await forTenant(ctx, db).agentActions.find({ limit: 100 })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.rev - b.rev);
}

beforeEach(() => {
  vi.stubEnv("AGENT_RECORD_ENABLED", "true");
  resetRecordFailures();
});
afterEach(() => vi.unstubAllEnvs());

describe("recordDraft", () => {
  it("records a draft as a proposed agent action holding ids, a label and a fingerprint only", async () => {
    const db = new FakeFirestore();
    expect(await recordDraft(A, journey(), { db, nowMs: T0 })).toBe("recorded");
    const [a] = await all(db);
    expect(a).toMatchObject({
      agent: "vizzy",
      action: "lifecycle_journey.draft",
      state: "proposed",
      target: { type: "brand", id: "ten_A" },
      personId: null,
      draft: { kind: "lifecycle_journey", ref: "lcj_spring" },
      review: { kind: "agent_draft", href: "/admin/lifecycle/lcj_spring" },
      requestedBy: { type: "member", id: "usr_a1" },
      proposal: { label: "Spring repotting", fingerprint: "aaaaaaaaaaaaaaaa" },
      basis: null,
      signals: [],
    });
    expect(Date.parse(a!.expiresAt) - T0).toBe(90 * 86_400_000);
  });

  it("finds a draft's open record by equality only, so it needs no composite index", async () => {
    const ops: string[] = [];
    const db = shapeRecordingFirestore(new FakeFirestore(), ops);
    await recordDraft(A, journey(), { db, nowMs: T0 });
    await openRecordsFor(A, { kind: "lifecycle_journey", ref: "lcj_spring" }, db);
    expect(ops.filter((o) => o.startsWith("orderBy"))).toEqual([]);
    expect(ops.every((o) => !o.startsWith("where") || o.endsWith(" =="))).toBe(true);
  });

  it("targets the launch's idea for a launch's drafts", async () => {
    const db = new FakeFirestore();
    await recordDraft(A, { action: "invite_wave.draft", draft: { kind: "invite_wave", ref: "wav_1" }, launchId: "camp1", href: "/admin/launches/camp1/invites?wave=wav_1", label: "First wave" }, { db, nowMs: T0 });
    const [a] = await all(db);
    expect(a).toMatchObject({ target: { type: "idea", id: "camp1" }, targetKey: "idea:camp1" });
  });

  it("keeps one open record per draft: a re-save supersedes the open one and keeps its action", async () => {
    const db = new FakeFirestore();
    await recordDraft(A, journey({ action: "launch_journey.draft", launchId: "camp1" }), { db, nowMs: T0 });
    // Vizzy styles the same journey: still one draft, still the launch's.
    expect(await recordDraft(A, journey({ action: "journey_style.suggest", fingerprint: "bbbbbbbbbbbbbbbb" }), { db, nowMs: T0 + MIN })).toBe("recorded");
    const rows = await all(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: "declined", declined: { reason: "superseded" }, decidedBy: { type: "system", id: "agent_record" }, proposal: null });
    expect(rows[1]).toMatchObject({ state: "proposed", action: "launch_journey.draft", target: { type: "idea", id: "camp1" }, proposal: { fingerprint: "bbbbbbbbbbbbbbbb" } });
    expect(await openRecordsFor(A, journey().draft, db)).toHaveLength(1);
  });

  it("writes nothing when Vizzy saves the same draft again unchanged", async () => {
    const db = new FakeFirestore();
    await recordDraft(A, journey(), { db, nowMs: T0 });
    expect(await recordDraft(A, journey(), { db, nowMs: T0 + MIN })).toBe("same");
    expect(await all(db)).toHaveLength(1);
  });

  it("opens a new record when a decided draft is saved again", async () => {
    const db = new FakeFirestore();
    await recordDraft(A, journey(), { db, nowMs: T0 });
    await closeDraft(A2, journey().draft, { to: "acted", by: { type: "member", id: "usr_a2" }, fingerprint: "aaaaaaaaaaaaaaaa" }, { db, nowMs: T0 + MIN });
    expect(await recordDraft(A, journey(), { db, nowMs: T0 + 2 * MIN })).toBe("recorded");
    const rows = await all(db);
    expect(rows.map((r) => r.state)).toEqual(["acted", "proposed"]);
  });

  it("proposes nothing while off, but still supersedes a record left open", async () => {
    const db = new FakeFirestore();
    await recordDraft(A, journey(), { db, nowMs: T0 });
    vi.stubEnv("AGENT_RECORD_ENABLED", "false");
    expect(await recordDraft(A, journey({ fingerprint: "cccccccccccccccc" }), { db, nowMs: T0 + MIN })).toBe("off");
    const rows = await all(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "declined", declined: { reason: "superseded" } });
    // Off with nothing recorded: one read, no write.
    const fresh = new FakeFirestore();
    expect(await recordDraft(A, journey(), { db: fresh, nowMs: T0 })).toBe("off");
    expect(await all(fresh)).toEqual([]);
  });

  it("never fails the save when a write fails: it logs and counts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = failingFirestore(new FakeFirestore(), { collections: ["agent_actions"] });
    expect(await recordDraft(A, journey(), { db, nowMs: T0 })).toBe("failed");
    expect(await closeDraft(A, journey().draft, { to: "declined", reason: "dismissed", by: { type: "member", id: "usr_a1" } }, { db })).toBe(0);
    expect(recordFailures()).toBe(2);
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("[agent-record] write_failed"))).toBe(true);
    warn.mockRestore();
  });
});

describe("closeDraft", () => {
  it("closes as acted by the member, edited when the fingerprint moved, and keeps the label in its result", async () => {
    const db = new FakeFirestore();
    await recordDraft(A, journey(), { db, nowMs: T0 });
    const n = await closeDraft(A2, journey().draft, { to: "acted", by: { type: "member", id: "usr_a2" }, fingerprint: async () => "dddddddddddddddd" }, { db, nowMs: T0 + MIN });
    expect(n).toBe(1);
    const [a] = await all(db);
    expect(a).toMatchObject({ state: "acted", actedBy: { type: "member", id: "usr_a2" }, decidedBy: { type: "member", id: "usr_a2" }, result: { label: "Spring repotting", edited: true }, proposal: null });
  });

  it("counts one decision once: two records left open by saves at the same time close as one kept and one superseded", async () => {
    const db = new FakeFirestore();
    // Two saves that ran at once both found nothing open, so both proposed.
    await Promise.all([recordDraft(A, journey(), { db, nowMs: T0 }), recordDraft(A, journey({ fingerprint: "bbbbbbbbbbbbbbbb" }), { db, nowMs: T0 + 1000 })]);
    expect(await openRecordsFor(A, journey().draft, db)).toHaveLength(2);
    expect(await closeDraft(A2, journey().draft, { to: "acted", by: { type: "member", id: "usr_a2" }, fingerprint: "bbbbbbbbbbbbbbbb" }, { db, nowMs: T0 + MIN })).toBe(1);
    const rows = await all(db);
    // The newest is the one kept; the older one was nobody's decision.
    expect(rows.map((r) => [r.state, r.declined?.reason ?? null, r.decidedBy?.type ?? null])).toEqual([
      ["declined", "superseded", "system"],
      ["acted", null, "member"],
    ]);
    expect(rows[1]).toMatchObject({ result: { label: "Spring repotting", edited: false } });
  });

  it("asks 0e to clear the proposal on close, so its own expiry sweep keeps nothing of the draft", async () => {
    const db = new FakeFirestore();
    await recordDraft(A, { ...journey(), action: "brand_map.research", draft: { kind: "brand_map", ref: "run_1" }, label: null, fingerprint: null, keys: ["1111111111111111"], refs: ["sub:sub_1"] }, { db, nowMs: T0 });
    await recordDraft(A, journey(), { db, nowMs: T0 });
    expect((await all(db)).every((a) => a.clearDetailsOnClose)).toBe(true);
    const r = await expireAgentActions(A, { now: new Date(T0 + 91 * 86_400_000).toISOString(), db });
    expect(r.declined).toBe(2);
    for (const a of await all(db)) {
      expect(a).toMatchObject({ state: "declined", declined: { reason: "expired" }, proposal: null });
      expect(a.detailsClearedAt).toBeTruthy();
    }
  });

  it("is not edited when a person opens and saves it with no change", async () => {
    const db = new FakeFirestore();
    await recordDraft(A, journey(), { db, nowMs: T0 });
    await closeDraft(A2, journey().draft, { to: "acted", by: { type: "member", id: "usr_a2" }, fingerprint: "aaaaaaaaaaaaaaaa" }, { db, nowMs: T0 + MIN });
    expect((await all(db))[0]).toMatchObject({ state: "acted", result: { edited: false } });
  });

  it("clears the proposal when a person dismisses it", async () => {
    const db = new FakeFirestore();
    await recordDraft(A, journey(), { db, nowMs: T0 });
    await closeDraft(A2, journey().draft, { to: "declined", reason: "dismissed", by: { type: "member", id: "usr_a2" } }, { db, nowMs: T0 + MIN });
    expect((await all(db))[0]).toMatchObject({ state: "declined", declined: { reason: "dismissed" }, proposal: null });
  });

  it("closes whatever the switch says, and reads once with nothing open", async () => {
    const db = new FakeFirestore();
    await recordDraft(A, journey(), { db, nowMs: T0 });
    vi.stubEnv("AGENT_RECORD_ENABLED", "false");
    expect(await closeDraft(A2, journey().draft, { to: "declined", reason: "dismissed", by: { type: "member", id: "usr_a2" } }, { db })).toBe(1);
    expect(await closeDraft(A2, { kind: "invite_wave", ref: "wav_none" }, { to: "declined", reason: "dismissed", by: { type: "member", id: "usr_a2" } }, { db })).toBe(0);
  });

  it("never touches another brand's draft", async () => {
    const db = new FakeFirestore();
    await recordDraft(A, journey(), { db, nowMs: T0 });
    expect(await closeDraft(B, journey().draft, { to: "declined", reason: "dismissed", by: { type: "member", id: "usr_b1" } }, { db })).toBe(0);
    expect((await all(db))[0]!.state).toBe("proposed");
  });
});

describe("a style's record", () => {
  it("is found by its suggestedAt, with no lookup, and closes as applied or dismissed", async () => {
    const db = new FakeFirestore();
    const at = "2026-12-03T09:00:00.000Z";
    await recordDraft(A, { action: "email_style.suggest", draft: { kind: "email_style", ref: "ten_A" }, keyPart: styleKeyPart(at), href: "/admin/brand-kit/email-style", fingerprint: "eeeeeeeeeeeeeeee" }, { db, nowMs: T0 });
    const [a] = await all(db);
    expect(a!.id).toBe(styleRecordId("ten_A", "email_style.suggest", at));
    expect(await closeStyle(A2, "email_style.suggest", "2026-12-03T09:00:01.000Z", { to: "acted", by: { type: "member", id: "usr_a2" } }, { db })).toBe(false);
    expect(await closeStyle(A2, "email_style.suggest", at, { to: "acted", by: { type: "member", id: "usr_a2" }, fingerprint: "eeeeeeeeeeeeeeee" }, { db, nowMs: T0 + MIN })).toBe(true);
    expect((await all(db))[0]).toMatchObject({ state: "acted", result: { edited: false } });
  });

  it("moves to the newer suggestedAt when the same style is suggested again, so Save from the newer one closes it", async () => {
    const db = new FakeFirestore();
    const style = (at: string): RecordDraftInput => ({ action: "email_style.suggest", draft: { kind: "email_style", ref: "ten_A" }, keyPart: styleKeyPart(at), href: "/admin/brand-kit/email-style", fingerprint: "eeeeeeeeeeeeeeee" });
    const t1 = "2026-12-03T09:00:00.000Z";
    const t2 = "2026-12-03T09:05:00.000Z";
    expect(await recordDraft(A, style(t1), { db, nowMs: T0 })).toBe("recorded");
    // The same colours again: the brand record now names t2, so the record follows it.
    expect(await recordDraft(A, style(t2), { db, nowMs: T0 + MIN })).toBe("recorded");
    // The same suggestion saved again with the same suggestedAt: nothing to write.
    expect(await recordDraft(A, style(t2), { db, nowMs: T0 + 2 * MIN })).toBe("same");
    expect(await closeStyle(A2, "email_style.suggest", t2, { to: "acted", by: { type: "member", id: "usr_a2" }, fingerprint: "eeeeeeeeeeeeeeee" }, { db, nowMs: T0 + 3 * MIN })).toBe(true);
    expect((await all(db)).map((r) => [r.id, r.state, r.declined?.reason ?? null, r.actedBy?.id ?? null])).toEqual([
      [styleRecordId("ten_A", "email_style.suggest", t1), "declined", "superseded", null],
      [styleRecordId("ten_A", "email_style.suggest", t2), "acted", null, "usr_a2"],
    ]);
  });

  it("is superseded by a newer suggestion: the brand's style is one draft", async () => {
    const db = new FakeFirestore();
    const style = (at: string, fp: string): RecordDraftInput => ({ action: "image_style.suggest", draft: { kind: "image_style", ref: "ten_A" }, keyPart: styleKeyPart(at), href: "/admin/brand-kit/image-style", fingerprint: fp });
    await recordDraft(A, style("2026-12-03T09:00:00.000Z", "1111111111111111"), { db, nowMs: T0 });
    await recordDraft(A, style("2026-12-04T09:00:00.000Z", "2222222222222222"), { db, nowMs: T0 + MIN });
    expect((await all(db)).map((r) => [r.state, r.declined?.reason ?? null])).toEqual([
      ["declined", "superseded"],
      ["proposed", null],
    ]);
  });
});

describe("erasing a launch", () => {
  it("erases its drafts' records, which target its idea, and leaves the brand's", async () => {
    const db = new FakeFirestore();
    db.seed("campaigns", "camp1", { tenantId: "ten_A", waitlistName: "Spring sale" });
    await recordDraft(A, { action: "invite_wave.draft", draft: { kind: "invite_wave", ref: "wav_1" }, launchId: "camp1", href: "/admin/launches/camp1/invites?wave=wav_1" }, { db, nowMs: T0 });
    await recordDraft(A, journey(), { db, nowMs: T0 });
    const sink: AuditObjectSink = { put: async () => undefined };
    const ctx: TenantContext = { ...A, source: "idtoken", email: "admin@example.com" };
    await deleteLaunch(ctx, "camp1", {}, db, sink);
    const left = await all(db);
    expect(left.map((r) => r.action)).toEqual(["lifecycle_journey.draft"]);
  });
});
