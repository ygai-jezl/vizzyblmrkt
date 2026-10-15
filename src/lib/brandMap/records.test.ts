import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import {
  addQuestion,
  createGroup,
  createSubject,
  editQuestion,
  editSubject,
  getSubject,
  listGroups,
  listSubjects,
  mergeSubjects,
  removeGroup,
  removeQuestion,
  removeSubject,
  renameGroup,
  subjectIndex,
  subjectQuestions,
} from "./records";
import { ensureMoved } from "./move";
import { readBrandMap } from "./store";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const db = new FakeFirestore();
  await ensureMoved(ctx, { db, nowMs: NOW });
  return { db, deps: { db, nowMs: NOW } };
}

describe("a person editing the map's records", () => {
  it("adds a subject once, by its name, and the map counts as saved", async () => {
    const { db, deps } = await setup();
    const made = await createSubject(ctx, { name: "  Share   of voice ", home: "https://acme.example/sov", ownSites: ["acme.example"] }, deps);
    expect(made.ok && made.value).toMatchObject({ name: "Share of voice", nameKey: "share of voice", status: "decided", from: "person", home: "https://acme.example/sov", rev: 0 });
    expect(await createSubject(ctx, { name: "share of VOICE" }, deps)).toMatchObject({ ok: false, status: 409, error: "subject_exists" });
    expect(await createSubject(ctx, { name: "Elsewhere", home: "https://other.example/x", ownSites: ["acme.example"] }, deps)).toMatchObject({ ok: false, error: "home_not_own_site" });
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.recordsDecidedAt).toBe("2026-10-15T10:00:00.000Z");
  });

  it("refuses an edit over someone else's, with the subject as it is now", async () => {
    const { deps } = await setup();
    const made = await createSubject(ctx, { name: "Citations" }, deps);
    const id = made.ok ? made.value.id : "";
    const first = await editSubject(ctx, id, { baseRev: 0, name: "AI citations" }, deps);
    expect(first.ok && first.value).toMatchObject({ name: "AI citations", rev: 1 });
    const stale = await editSubject(ctx, id, { baseRev: 0, name: "Sources" }, deps);
    expect(stale).toMatchObject({ ok: false, status: 409, error: "record_changed", current: { name: "AI citations", rev: 1 } });
  });

  it("keeps a subject's questions in order, each once on the whole map", async () => {
    const { deps } = await setup();
    const a = await createSubject(ctx, { name: "Share of voice" }, deps);
    const b = await createSubject(ctx, { name: "Citations" }, deps);
    const sa = a.ok ? a.value.id : "";
    const sb = b.ok ? b.value.id : "";
    await addQuestion(ctx, sa, { text: "What is share of voice?", intent: "definition" }, deps);
    await addQuestion(ctx, sa, { text: "How is it measured?" }, deps);
    expect(await addQuestion(ctx, sb, { text: "What is share of voice?" }, deps)).toMatchObject({ ok: false, error: "question_exists" });
    expect((await subjectQuestions(ctx, sa, deps)).map((q) => [q.text, q.order, q.intent])).toEqual([
      ["What is share of voice?", 0, "definition"],
      ["How is it measured?", 1, "other"],
    ]);
    // Moving a question to another subject touches both.
    const [q] = await subjectQuestions(ctx, sa, deps);
    const moved = await editQuestion(ctx, q!.id, { baseRev: 0, subjectId: sb }, deps);
    expect(moved.ok && moved.touched.sort()).toEqual([sa, sb].sort());
    expect((await removeQuestion(ctx, q!.id, deps)).ok).toBe(true);
  });

  it("merges one subject into another, keeping a pointer so old links still lead somewhere", async () => {
    const { deps } = await setup();
    const a = await createSubject(ctx, { name: "Share of voice" }, deps);
    const b = await createSubject(ctx, { name: "Voice share" }, deps);
    const sa = a.ok ? a.value.id : "";
    const sb = b.ok ? b.value.id : "";
    await addQuestion(ctx, sa, { text: "What is share of voice?" }, deps);
    await addQuestion(ctx, sb, { text: "How do I track it?" }, deps);
    const merged = await mergeSubjects(ctx, { from: sb, into: sa }, deps);
    expect(merged.ok && merged.value).toEqual({ moved: 1, dropped: 0 });
    expect((await getSubject(ctx, sb, deps))?.id).toBe(sa);
    expect((await subjectQuestions(ctx, sa, deps)).map((q) => q.text)).toEqual(["What is share of voice?", "How do I track it?"]);
    expect((await listSubjects(ctx, {}, deps)).map((s) => s.name)).toEqual(["Share of voice"]);
  });

  it("groups subjects, lists one group's, and leaves them ungrouped when a group goes", async () => {
    const { deps } = await setup();
    const g = await createGroup(ctx, { name: "Tracking your brand in AI" }, deps);
    const gid = g.ok ? g.value.id : "";
    expect(await createGroup(ctx, { name: "tracking your brand in ai" }, deps)).toMatchObject({ ok: false, error: "group_exists" });
    await createSubject(ctx, { name: "Share of voice", groupId: gid }, deps);
    await createSubject(ctx, { name: "Citations" }, deps);
    expect((await listSubjects(ctx, { groupId: gid }, deps)).map((s) => s.name)).toEqual(["Share of voice"]);
    expect((await listSubjects(ctx, { groupId: null }, deps)).map((s) => s.name)).toEqual(["Citations"]);
    const renamed = await renameGroup(ctx, gid, { baseRev: 0, name: "Tracking" }, deps);
    expect(renamed.ok && renamed.value.name).toBe("Tracking");
    expect((await listGroups(ctx, deps)).map((x) => x.name)).toEqual(["Tracking"]);
    expect(await removeGroup(ctx, gid, deps)).toMatchObject({ ok: true, value: { subjects: 1 } });
    expect((await listSubjects(ctx, { groupId: null }, deps)).map((s) => s.name).sort()).toEqual(["Citations", "Share of voice"]);
  });

  it("removes a subject with its questions, and lists every name for search", async () => {
    const { db, deps } = await setup();
    const a = await createSubject(ctx, { name: "Share of voice" }, deps);
    const sa = a.ok ? a.value.id : "";
    await addQuestion(ctx, sa, { text: "What is it?" }, deps);
    await createSubject(ctx, { name: "Citations" }, deps);
    expect((await subjectIndex(ctx, deps)).map((s) => s.name).sort()).toEqual(["Citations", "Share of voice"]);
    expect(await removeSubject(ctx, sa, deps)).toMatchObject({ ok: true, value: { questions: 1 } });
    expect(await brandMapRecords(ctx, db).find("q")).toEqual([]);
  });
});
