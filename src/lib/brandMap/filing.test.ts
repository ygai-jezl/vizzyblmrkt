import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { fileSuggestions } from "./filing";
import { decideProposals } from "./proposals";
import { createSubject } from "./records";
import { readBrandMap, saveBrandMap } from "./store";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");

beforeEach(() => vi.stubEnv("BRAND_MAP_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

const ITEMS = [
  { change: { type: "add_subject" as const, name: "Audits" }, reason: "Buyers ask" },
  { change: { type: "add_question" as const, subject: "Audits", text: "What does an audit check?", intent: "definition" as const } },
  { change: { type: "add_name" as const, name: "Rivalco", kind: "alternative" as const, aliases: [] } },
];

describe("filing suggestions", () => {
  it("files everything on the brand's record with the map at any size off, as before", async () => {
    const db = new FakeFirestore();
    const r = await fileSuggestions(ctx, { from: "research", items: ITEMS }, { db, nowMs: NOW });
    expect(r.ok && r.value.filed.map((s) => s.change.type)).toEqual(["add_subject", "add_question", "add_name"]);
    expect(r.ok && r.value.proposed).toEqual([]);
    expect(await brandMapRecords(ctx, db).find("sub")).toEqual([]);
  });

  it("with it on, moves the map and turns suggestions about subjects into proposals", async () => {
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
    const db = new FakeFirestore();
    await saveBrandMap(ctx, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme" } }) }, { db, nowMs: NOW });
    const r = await fileSuggestions(ctx, { from: "research", items: ITEMS }, { db, nowMs: NOW });
    expect(r.ok && r.value.proposed).toEqual(["Add a subject: “Audits”", "Add a question to “Audits”: “What does an audit check?”"]);
    expect(r.ok && r.value.filed.map((s) => s.change.type)).toEqual(["add_name"]);
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.moved).toBeTruthy();
    const store = brandMapRecords(ctx, db);
    expect((await store.find("sub")).map((s) => [s.name, s.status, s.from, s.reason])).toEqual([["Audits", "proposed", "research", "Buyers ask"]]);
    // The same again proposes nothing new.
    const again = await fileSuggestions(ctx, { from: "research", items: ITEMS.slice(0, 2) }, { db, nowMs: NOW });
    expect(again.ok && again.value).toMatchObject({ proposed: [], skipped: { inMap: 2 } });
  });

  it("never proposes what a person dismissed, unless someone asks for it outright", async () => {
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
    const db = new FakeFirestore();
    await fileSuggestions(ctx, { from: "research", items: ITEMS.slice(0, 1) }, { db, nowMs: NOW });
    const [audits] = await brandMapRecords(ctx, db).find("sub");
    await decideProposals(ctx, { dismiss: { subjects: [audits!.id] } }, { db, nowMs: NOW });
    const research = await fileSuggestions(ctx, { from: "research", items: ITEMS.slice(0, 1) }, { db, nowMs: NOW });
    expect(research.ok && research.value.proposed).toEqual([]);
    const asked = await fileSuggestions(ctx, { from: "vizzy", allowDismissed: true, items: ITEMS.slice(0, 1) }, { db, nowMs: NOW });
    expect(asked.ok && asked.value.proposed).toEqual(["Add a subject: “Audits”"]);
  });
});

describe("deciding proposals", () => {
  beforeEach(() => vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true"));

  it("accepting a question accepts the subject it's for; dismissing a subject dismisses its proposed questions", async () => {
    const db = new FakeFirestore();
    await fileSuggestions(ctx, { from: "research", items: ITEMS.slice(0, 2) }, { db, nowMs: NOW });
    await fileSuggestions(ctx, { from: "research", items: [{ change: { type: "add_question", subject: "Prompts", text: "Which prompts matter?", intent: "how_to" } }] }, { db, nowMs: NOW });
    const store = brandMapRecords(ctx, db);
    const subjects = await store.find("sub");
    const audits = subjects.find((s) => s.name === "Audits")!;
    const prompts = subjects.find((s) => s.name === "Prompts")!;
    const [auditQ] = await store.find("q", { where: [["subjectId", "==", audits.id]] });

    const decided = await decideProposals(ctx, { accept: { questions: [auditQ!.id] }, dismiss: { subjects: [prompts.id] } }, { db, nowMs: NOW });
    expect(decided).toMatchObject({ accepted: 1, dismissed: 1 });
    expect(decided.touched.sort()).toEqual([audits.id, prompts.id].sort());
    expect((await store.get("sub", audits.id))?.status).toBe("decided");
    expect((await store.get("q", auditQ!.id))?.status).toBe("decided");
    expect((await store.find("q", { where: [["subjectId", "==", prompts.id]] })).map((q) => q.status)).toEqual(["dismissed"]);
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.recordsDecidedAt).toBeTruthy();
  });

  it("leaves what is already decided as it is", async () => {
    const db = new FakeFirestore();
    const made = await createSubject(ctx, { name: "Share of voice" }, { db, nowMs: NOW });
    const id = made.ok ? made.value.id : "";
    expect(await decideProposals(ctx, { dismiss: { subjects: [id] } }, { db, nowMs: NOW })).toMatchObject({ dismissed: 0 });
    expect((await brandMapRecords(ctx, db).get("sub", id))?.status).toBe("decided");
  });
});
