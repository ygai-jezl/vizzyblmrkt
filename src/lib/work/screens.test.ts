import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addTask, editTask } from "./service";
import { addLogEntry } from "./log";
import type { WorkResult } from "./result";
import { addScreen, listScreen, logScreen, screenScope, taskScreen } from "./screens";
import { FERNHILL, makeWorld, PEOPLE, REPO, type World } from "./testing/world";
import { LUMEN_EU, LUMEN_US } from "./testing/fixtures";
import type { TenantContext } from "@/lib/tenant/types";

// What Work's screens read on the server. Lumen [made up] has Lumen Notes in the United States
// (New York time, a repo selected) and Lumen Europe; Nina owns it, Sam is a member of Lumen Notes.
// Fernhill Plants is one brand with no owners.
let w: World;
beforeEach(() => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
  w.us.seed("campaigns", "team-spaces", { tenantId: LUMEN_US, waitlistName: "Team spaces", createdAt: "2026-11-01T00:00:00.000Z" });
  w.us.seed("product_connections", "pc_lumen", { tenantId: LUMEN_US, name: "Lumen app", status: "active", catalog: { events: [{ name: "note_from_template", label: "Notes made from a template" }] } });
  w.us.seed("product_connections", "pc_old", { tenantId: LUMEN_US, name: "Old app", status: "revoked", catalog: { events: [] } });
});
afterEach(() => vi.unstubAllEnvs());

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.value;
}
const add = async (who: TenantContext, body: Parameters<typeof addTask>[1]) => value(await addTask(await w.scope(who), body, w.deps)).task.task;
const list = async (who: TenantContext, q = "") => listScreen(await w.scope(who), new URLSearchParams(q), w.deps);

describe("the list screen", () => {
  it("shows an owner every brand's tasks with a Brand column, and names the ideas a task touches", async () => {
    await add(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US, mustHave: true, typedLinks: [{ kind: "idea", brandId: LUMEN_US, ideaId: "team-spaces" }] });
    await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    const s = await list(PEOPLE.nina);
    expect(s).toMatchObject({ name: "Lumen", view: "organisation", owner: true, multiBrand: true, member: false, empty: false, canImport: true });
    expect(s.rows.map((r) => [r.title, r.brand])).toEqual([
      ["Credits and pricing page", "Lumen Notes"],
      ["Cookie notice in German", "Lumen Europe"],
    ]);
    expect(s.rows[0]!.ideas).toEqual(["Team spaces"]);
    expect(s.counts).toEqual({ open: 2, mustHave: 1, due: 0 });
  });

  it("shows a member only their brand's tasks, with no brand filter, as a member", async () => {
    await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    await add(PEOPLE.sam, { title: "Interview 5 team admins" });
    const s = await list(PEOPLE.sam, `brand=${LUMEN_EU}`);
    expect(s).toMatchObject({ view: "brand", multiBrand: false, member: true, canImport: false, canDelete: false });
    expect(s.filters.brand).toBeNull();
    expect(s.rows.map((r) => r.title)).toEqual(["Interview 5 team admins"]);
  });

  it("drops a brand filter the person can't use, so a stale link still opens", async () => {
    await add(PEOPLE.nina, { title: "A", brandId: LUMEN_US });
    const s = await list(PEOPLE.nina, `brand=${FERNHILL}&stage=market`);
    expect(s.filters).toMatchObject({ brand: null, stage: "market" });
  });

  it("is empty on a first visit only, not when every task is done", async () => {
    expect((await list(PEOPLE.priya)).empty).toBe(true);
    await add(PEOPLE.priya, { title: "Register the business name", status: "done" });
    const s = await list(PEOPLE.priya);
    expect(s).toMatchObject({ empty: false, rows: [], oneBrand: true, multiBrand: false });
  });

  it("says why Work can't show anything for a brand whose organisation doesn't list it", async () => {
    w.control.seed("tenants", "ten_drift", { tenantName: "Drift", rootDomain: "drift.example", ownerId: "uid_x", status: "active", region: "us", allowedOrigins: [], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", organisationId: "org_ten_lumen" });
    const gate = await screenScope({ tenantId: "ten_drift", region: "us", source: "idtoken", userId: "uid_x", role: "admin" }, w.deps);
    expect(gate).toMatchObject({ ok: false });
    expect(!gate.ok && gate.message).toContain("doesn't list it back");
  });
});

describe("the add page", () => {
  it("offers the next ref, the brands with their repos, products, ideas and open tasks", async () => {
    await add(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US });
    const s = await addScreen(await w.scope(PEOPLE.nina), w.deps);
    expect(s.nextRef).toBe(2);
    expect(s.defaultBrandId).toBe(LUMEN_US);
    expect(s.options.wholeBusiness).toBe(true);
    const us = s.options.brands.find((b) => b.id === LUMEN_US)!;
    expect(us).toMatchObject({ name: "Lumen Notes", region: "us", timeZone: "America/New_York", today: "2026-11-20", repos: [{ provider: "github", fullPath: REPO }] });
    expect(us.products).toEqual([{ id: "pc_lumen", name: "Lumen app", events: [{ name: "note_from_template", label: "Notes made from a template" }] }]);
    expect(s.options.brands.find((b) => b.id === LUMEN_EU)!.repos).toEqual([]);
    expect(s.options.ideas).toEqual([{ value: `${LUMEN_US}:team-spaces`, label: "Team spaces (Lumen Notes)" }]);
    expect(s.options.openTasks).toEqual([{ ref: 1, title: "Credits and pricing page", status: "todo" }]);
    expect(s.options.meanings).toContain("conversions");
    expect(s.options).toMatchObject({ operator: false, loopsRepo: null });
  });

  it("gives a member their own brand only, and an operator this copy's own repo for the loop line", async () => {
    const sam = await addScreen(await w.scope(PEOPLE.sam), w.deps);
    expect(sam.options.brands.map((b) => b.id)).toEqual([LUMEN_US]);
    expect(sam.options.wholeBusiness).toBe(false);
    vi.stubEnv("LOOPS_OPERATOR_EMAILS", "nina@lumen.example");
    vi.stubEnv("LOOPS_SOURCE_REPO", REPO);
    const nina = await addScreen(await w.scope(PEOPLE.nina), w.deps);
    expect(nina.options).toMatchObject({ operator: true, loopsRepo: REPO.toLowerCase() });
    expect(nina.options.meanings).toContain("declineShare");
  });

  it("starts the brand's word for conversions from its newest task that has one", async () => {
    await add(PEOPLE.nina, { title: "Gift cards", brandId: LUMEN_US, measure: { kind: "moves", meaning: "conversions", word: "Sign ups", look: { days: 14 } } });
    const s = await addScreen(await w.scope(PEOPLE.nina), w.deps);
    expect(s.options.brands.find((b) => b.id === LUMEN_US)!.word).toBe("Sign ups");
    expect(s.options.brands.find((b) => b.id === LUMEN_EU)!.word).toBeNull();
  });
});

describe("the task page", () => {
  it("offers only brands kept in the task's region, and Make it an idea for the session brand's task", async () => {
    const us = await add(PEOPLE.nina, { title: "Team spaces sharing", brandId: LUMEN_US });
    const eu = await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    const scope = await w.scope(PEOPLE.nina);
    const a = (await taskScreen(scope, us.ref, w.deps))!;
    expect(a.brandChoices).toEqual([{ id: LUMEN_US, name: "Lumen Notes" }]);
    expect(a.makeIdeaHref).toBe(`/admin/launches/new?name=Team%20spaces%20sharing&task=${us.ref}`);
    expect(a.measureBrand).toMatchObject({ id: LUMEN_US, products: [{ id: "pc_lumen" }] });
    const b = (await taskScreen(scope, eu.ref, w.deps))!;
    expect(b.brandChoices).toEqual([{ id: LUMEN_EU, name: "Lumen Europe" }]);
    expect(b.makeIdeaHref).toBeNull();
  });

  it("is not found for a task the person can't see", async () => {
    const eu = await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    expect(await taskScreen(await w.scope(PEOPLE.sam), eu.ref, w.deps)).toBeNull();
    expect(await taskScreen(await w.scope(PEOPLE.sam), 999, w.deps)).toBeNull();
  });

  it("words a due measure's check: the part it asks about and what Work counted", async () => {
    const t = await add(PEOPLE.nina, { title: "Fix the sync crash", brandId: LUMEN_US, measure: { kind: "runs_better", what: "crashes", look: { days: 7 } } });
    await editTask(await w.scope(PEOPLE.nina), t.ref, { status: "done" }, w.deps);
    w.at("2026-11-27T14:00:00.000Z");
    const s = (await taskScreen(await w.scope(PEOPLE.nina), t.ref, w.deps))!;
    expect(s.page.due).toBe(true);
    expect(s.checkPartLine).toBe("Runs better: crashes, 7 days after it's done.");
    expect(s.page.checkLine).toBe("Work can't count crashes, so your read is the record.");
    expect(s.today).toBe("2026-11-27");
  });

  it("names a product event by its catalog label, as the picker does, on the task page and the Log", async () => {
    const t = await add(PEOPLE.nina, { title: "Templates", brandId: LUMEN_US, measure: { kind: "used", counts: { productEvent: { connectionId: "pc_lumen", event: "note_from_template" } }, look: { days: 7 } }, status: "done" });
    w.us.seed("product_events", "pe_1", { tenantId: LUMEN_US, connectionId: "pc_lumen", type: "track", event: "note_from_template", receivedAt: "2026-11-22T12:00:00.000Z" });
    w.us.seed("product_events", "pe_2", { tenantId: LUMEN_US, connectionId: "pc_lumen", type: "track", event: "note_from_template", receivedAt: "2026-11-23T12:00:00.000Z" });
    w.at("2026-11-27T14:00:00.000Z");
    const s = (await taskScreen(await w.scope(PEOPLE.nina), t.ref, w.deps))!;
    expect(s.checkPartLine).toBe("Used: notes made from a template from Lumen app, 7 days after it's done.");
    expect(s.page.checkLine).toBe("Work counted 2 notes made from a template from Lumen Notes' product since 20 Nov.");
    const r = await logScreen(await w.scope(PEOPLE.nina), null, w.deps);
    if (!r.ok) throw new Error(r.message);
    expect(r.screen.checks[0]!.line).toBe("Used: notes made from a template, 7 days after it's done. Work counted 2 notes made from a template from Lumen Notes' product since 20 Nov.");
  });
});

describe("the Log screen", () => {
  it("shows today's workstreams with who wrote them, the checks due with their words, and the open tasks to log against", async () => {
    const t = await add(PEOPLE.nina, { title: "Nightly check of search answers", brandId: LUMEN_US, check: { kind: "date", day: "2026-11-20", time: "09:00", note: "After last night's runs" } });
    await addLogEntry(await w.scope(PEOPLE.sam), { workstream: "Team spaces sharing", state: "doing", note: "Invites by email first" }, w.deps);
    const r = await logScreen(await w.scope(PEOPLE.nina), null, w.deps);
    if (!r.ok) throw new Error(r.message);
    const s = r.screen;
    expect(s.day.today).toBe(true);
    expect(s.day.inFlight.map((f) => [f.workstream, f.by.id])).toEqual([["Team spaces sharing", "uid_sam"]]);
    // Nina added the task today, so she is named too.
    expect(s.names).toEqual({ uid_nina: "nina", uid_sam: "sam" });
    expect(s.day.moved.map((m) => m.taskId)).toEqual([t.id]);
    expect(s.checks).toEqual([{ ref: t.ref, title: "Nightly check of search answers", brandName: "Lumen Notes", byMeasure: false, line: "After last night's runs" }]);
    expect(s.openTasks).toEqual([{ ref: t.ref, title: "Nightly check of search answers", status: "todo" }]);
    expect(s.openCount).toBe(1);
    expect(s.logBrands.map((b) => b.id)).toEqual([LUMEN_US, LUMEN_EU]);
    expect(s.wholeBusiness).toBe(true);
  });

  it("refuses a day after today in words", async () => {
    const r = await logScreen(await w.scope(PEOPLE.nina), "2026-12-01", w.deps);
    expect(r).toEqual({ ok: false, message: "That isn't a day Work can show." });
  });
});
