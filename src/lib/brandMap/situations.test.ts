import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { situationKey } from "./keys";
import { ensureMoved } from "./move";
import { decideProposals } from "./proposals";
import { addQuestion, createSubject } from "./records";
import { createSituation, editSituation, listSituations, readSituation, removeSituation } from "./situations";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const quiet = { embed: async () => [] };

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const db = new FakeFirestore();
  await ensureMoved(ctx, { db, nowMs: NOW });
  return db;
}

describe("buying situations", () => {
  it("adds one in the buyer's words, once, and brings back one dismissed before", async () => {
    const db = await setup();
    const deps = { db, nowMs: NOW, embed: quiet };
    const made = await createSituation(ctx, { text: "Our clicks from Google are falling, but our rankings aren't", who: "Head of SEO", side: "professional", w: "why", wText: "after the monthly report" }, deps);
    expect(made).toMatchObject({ ok: true, value: { status: "decided", from: "person", who: "Head of SEO", side: "professional", wText: "after the monthly report" } });
    expect(await createSituation(ctx, { text: "OUR CLICKS FROM GOOGLE ARE FALLING — BUT OUR RANKINGS AREN'T!" }, deps)).toMatchObject({ ok: false, status: 409, error: "situation_exists" });
    expect(await createSituation(ctx, { text: "  " }, deps)).toMatchObject({ ok: false, status: 400 });

    const store = brandMapRecords(ctx, db);
    const launching = "We're launching a product";
    await store.create("sit", "sit_proposed01", { status: "proposed", from: "research", text: launching, textKey: situationKey(launching), backed: false, rev: 0, createdAt: "", updatedAt: "" });
    await decideProposals(ctx, { dismiss: { situations: ["sit_proposed01"] } }, deps);
    expect((await listSituations(ctx, deps)).map((s) => s.text)).toEqual(["Our clicks from Google are falling, but our rankings aren't"]);
    const back = await createSituation(ctx, { text: launching }, deps);
    expect(back).toMatchObject({ ok: true, value: { id: "sit_proposed01", status: "decided" } });
  });

  it("refuses a stale edit with the situation as it is, and puts the ones starred first", async () => {
    const db = await setup();
    const deps = { db, nowMs: NOW, embed: quiet };
    const a = await createSituation(ctx, { text: "The board asked what ChatGPT says about us" }, deps);
    const b = await createSituation(ctx, { text: "A competitor keeps coming up in AI answers" }, deps);
    const bid = b.ok ? b.value.id : "";
    expect(await editSituation(ctx, bid, { baseRev: 0, focus: true }, deps)).toMatchObject({ ok: true, value: { focus: true, rev: 1 } });
    expect(await editSituation(ctx, bid, { baseRev: 0, want: "Be named too" }, deps)).toMatchObject({ ok: false, status: 409, error: "record_changed", current: { rev: 1 } });
    expect((await listSituations(ctx, deps)).map((s) => s.id)).toEqual([bid, a.ok ? a.value.id : ""]);
  });

  it("opens with its questions, the subjects they're on and how far along each is, and counts them", async () => {
    const db = await setup();
    const deps = { db, nowMs: NOW, embed: quiet };
    const sit = await createSituation(ctx, { text: "The board asked what ChatGPT says about us" }, deps);
    const sid = sit.ok ? sit.value.id : "";
    const subject = await createSubject(ctx, { name: "AI answer monitoring" }, deps);
    const subId = subject.ok ? subject.value.id : "";
    const q1 = await addQuestion(ctx, subId, { text: "How do I see what ChatGPT says about my brand?", situationIds: [sid] }, deps);
    await addQuestion(ctx, subId, { text: "How often do AI answers change?", situationIds: [sid] }, deps);
    await addQuestion(ctx, subId, { text: "Unlinked question?" }, deps);
    // Its subject's lists say the first is answered.
    await brandMapRecords(ctx, db).claim("sub", subId, () => ({ answeredIds: [q1.ok ? q1.value.id : ""] }));

    const read = await readSituation(ctx, sid, deps);
    expect(read?.questions.map((q) => [q.text, q.subjectName, q.state])).toEqual([
      ["How do I see what ChatGPT says about my brand?", "AI answer monitoring", "answered"],
      ["How often do AI answers change?", "AI answer monitoring", "open"],
    ]);
    expect(read?.situation.counts).toEqual({ questions: 2, answered: 1 });
    expect((await brandMapRecords(ctx, db).get("sit", sid))?.counts).toEqual({ questions: 2, answered: 1 });

    // Removing it leaves its questions on their subject, unlinked.
    expect(await removeSituation(ctx, sid, deps)).toMatchObject({ ok: true, value: { questions: 2 } });
    expect((await brandMapRecords(ctx, db).get("q", q1.ok ? q1.value.id : ""))?.situationIds).toEqual([]);
    expect(await readSituation(ctx, sid, deps)).toBeNull();
  });
});
