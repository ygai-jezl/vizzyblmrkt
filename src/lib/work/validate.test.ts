import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addTask, editTask } from "./service";
import type { AddTaskBody, MeasureInput } from "./inputs";
import type { WorkResult } from "./result";
import { FERNHILL, makeWorld, PEOPLE, REPO, type World } from "./testing/world";
import { LUMEN_EU, LUMEN_US } from "./testing/fixtures";
import type { TenantContext } from "@/lib/tenant/types";
import type { TypedLink } from "./types";
import { PRODUCT_EVENT_MAX_DAYS } from "./validate";

let w: World;
beforeEach(() => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
  w.us.seed("product_connections", "pc_lumen", { tenantId: LUMEN_US, name: "Lumen app", status: "active" });
  w.us.seed("product_connections", "pc_gone", { tenantId: LUMEN_US, name: "Old app", status: "revoked" });
  w.eu.seed("product_connections", "pc_fern", { tenantId: FERNHILL, name: "Fernhill shop", status: "active" });
  w.us.seed("campaigns", "camp_partners", { tenantId: LUMEN_US, name: "Partner programme" });
});
afterEach(() => vi.unstubAllEnvs());

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}
const add = async (body: AddTaskBody, who: TenantContext = PEOPLE.nina) => addTask(await w.scope(who), body, w.deps);
const task = async (body: AddTaskBody, who: TenantContext = PEOPLE.nina) => value(await add(body, who)).task.task;
const pr = (repo = REPO, number = 412): TypedLink => ({ kind: "pull_request", provider: "github", repo, number });

describe("typed links", () => {
  it("keeps a pull request from a repo the brand selected, matched ignoring case, in the repo's own spelling", async () => {
    const t = await task({ title: "New sign in", brandId: LUMEN_US, typedLinks: [pr("lumen-example/NOTES-APP"), { kind: "switch", name: "PASSWORD_SIGN_IN_ENABLED" }] });
    expect(t.typedLinks).toEqual([pr(REPO), { kind: "switch", name: "PASSWORD_SIGN_IN_ENABLED" }]);
  });

  it("refuses a pull request from a repo the brand hasn't selected", async () => {
    expect(await add({ title: "New sign in", brandId: LUMEN_US, typedLinks: [pr("Lumen-Example/other")] })).toMatchObject({ ok: false, error: "repo_not_selected" });
    expect(await add({ title: "New sign in", brandId: LUMEN_US, typedLinks: [{ ...pr(), provider: "gitlab" }] as TypedLink[] })).toMatchObject({ ok: false, error: "repo_not_selected" });
  });

  it("refuses a pull request or a switch with no connected repo, and lets a whole business task use any brand's repo", async () => {
    expect(await add({ title: "Cookie notice", brandId: LUMEN_EU, typedLinks: [pr()] })).toMatchObject({ ok: false, error: "no_repo" });
    expect(await add({ title: "Cookie notice", brandId: LUMEN_EU, typedLinks: [{ kind: "switch", none: "no switch for a notice" }] })).toMatchObject({ ok: false, error: "no_repo" });
    expect(await add({ title: "Gift guide", typedLinks: [{ kind: "switch", name: "GIFTS_ENABLED" }] }, PEOPLE.priya)).toMatchObject({ ok: false, error: "no_repo" });
    expect((await task({ title: "Team plan", brandId: null, typedLinks: [pr()] })).typedLinks).toEqual([pr()]);
  });

  it("keeps an idea only when it exists, and a plan page for any business", async () => {
    expect(await add({ title: "Partners", brandId: LUMEN_US, typedLinks: [{ kind: "idea", brandId: LUMEN_US, ideaId: "camp_nope" }] })).toMatchObject({ ok: false, error: "idea_missing" });
    expect(await add({ title: "Partners", typedLinks: [{ kind: "idea", brandId: LUMEN_US, ideaId: "camp_partners" }] }, PEOPLE.leo)).toMatchObject({ ok: false, error: "idea_missing" });
    const plan: TypedLink = { kind: "plan", url: "https://plans.fernhill.example/delivery", title: "Delivery zones plan", version: "v1" };
    expect((await task({ title: "Delivery zones", typedLinks: [plan] }, PEOPLE.priya)).typedLinks).toEqual([plan]);
  });

  it("refuses a plan link unless https, up to 2,000 characters, with no user name or password, and with a title", async () => {
    const { TypedLinkSchema } = await import("./types");
    const ok = (l: unknown) => TypedLinkSchema.safeParse(l).success;
    expect(ok({ kind: "plan", url: "https://plans.example/p", title: "Plan" })).toBe(true);
    expect(ok({ kind: "plan", url: "http://plans.example/p", title: "Plan" })).toBe(false);
    expect(ok({ kind: "plan", url: `https://plans.example/${"a".repeat(2000)}`, title: "Plan" })).toBe(false);
    expect(ok({ kind: "plan", url: "https://nina:secret@plans.example/p", title: "Plan" })).toBe(false);
    expect(ok({ kind: "plan", url: "https://plans.example/p", title: "" })).toBe(false);
  });

  describe("a loop line (operators only)", () => {
    const line: TypedLink = { kind: "loop_line", none: "a page people only look at" };

    it("is refused for anyone LOOPS_OPERATOR_EMAILS doesn't name, and for everyone while it is empty", async () => {
      vi.stubEnv("LOOPS_SOURCE_REPO", REPO);
      expect(await add({ title: "New sign in", brandId: LUMEN_US, typedLinks: [pr(), line] })).toMatchObject({ ok: false, status: 403, error: "loop_line_operators" });
      vi.stubEnv("LOOPS_OPERATOR_EMAILS", "someone@example.com");
      expect(await add({ title: "New sign in", brandId: LUMEN_US, typedLinks: [pr(), line] })).toMatchObject({ ok: false, error: "loop_line_operators" });
    });

    it("needs a pull request from LOOPS_SOURCE_REPO on the task, and the address matches ignoring case", async () => {
      vi.stubEnv("LOOPS_OPERATOR_EMAILS", "NINA@lumen.EXAMPLE");
      expect(await add({ title: "New sign in", brandId: LUMEN_US, typedLinks: [pr(), line] })).toMatchObject({ ok: false, error: "loop_line_repo" });
      vi.stubEnv("LOOPS_SOURCE_REPO", "lumen-example/notes-app");
      expect(await add({ title: "New sign in", brandId: LUMEN_US, typedLinks: [line] })).toMatchObject({ ok: false, error: "loop_line_repo" });
      const t = await task({ title: "New sign in", brandId: LUMEN_US, typedLinks: [pr(), line, { kind: "loop_line", loopKind: "vizzy_chat" }] });
      expect(t.typedLinks.map((l) => l.kind)).toEqual(["pull_request", "loop_line", "loop_line"]);
    });

    it("is refused when it isn't a LOOPS key", async () => {
      const { TypedLinkSchema } = await import("./types");
      expect(TypedLinkSchema.safeParse({ kind: "loop_line", loopKind: "not_a_loop" }).success).toBe(false);
    });

    it("stays on a task once kept, whoever edits it next", async () => {
      vi.stubEnv("LOOPS_OPERATOR_EMAILS", "nina@lumen.example");
      vi.stubEnv("LOOPS_SOURCE_REPO", REPO);
      const t = await task({ title: "New sign in", brandId: LUMEN_US, typedLinks: [pr(), line] });
      vi.stubEnv("LOOPS_OPERATOR_EMAILS", "");
      const r = value(await editTask(await w.scope(PEOPLE.sam), t.ref, { typedLinks: [...t.typedLinks, { kind: "switch", name: "NEW_SIGN_IN_ENABLED" }] }, w.deps));
      expect(r.task.task.typedLinks).toHaveLength(3);
    });
  });
});

describe("how we'll know it worked", () => {
  const event = (connectionId = "pc_lumen", days = 14): MeasureInput => ({ kind: "used", counts: { productEvent: { connectionId, event: "note_from_template" } }, look: { days } });

  it("sets who set it and when on the server, and the kind the rule proposes, kept beside the one chosen", async () => {
    const t = await task({ title: "Register for VAT", brandId: LUMEN_US, stage: "billing_tax", measure: { kind: "runs_better", what: "cost", look: { days: 30 } } });
    expect(t.measure).toMatchObject({ kind: "runs_better", setBy: PEOPLE.nina.userId, setAt: "2026-11-20T15:00:00.000Z", proposed: { kind: "done", by: "rule" } });
  });

  it("runs the rule again on a later measure, and a measure set again unchanged changes nothing", async () => {
    const t = await task({ title: "Fix the crash on sync", brandId: LUMEN_US });
    w.at("2026-11-21T09:00:00.000Z");
    const r = value(await editTask(await w.scope(PEOPLE.sam), t.ref, { measure: { kind: "used", counts: { none: "" }, look: { days: 7 } } }, w.deps));
    expect(r.task.task.measure).toMatchObject({ kind: "used", setBy: PEOPLE.sam.userId, proposed: { kind: "runs_better", by: "rule" } });
    w.at("2026-11-22T09:00:00.000Z");
    const again = value(await editTask(await w.scope(PEOPLE.nina), t.ref, { measure: { kind: "used", counts: { none: "" }, look: { days: 7 } } }, w.deps));
    expect(again.task.task.measure).toEqual(r.task.task.measure);
    expect(again.task.task.updatedAt).toBe("2026-11-21T09:00:00.000Z");
    // In a one brand organisation every task counts as the brand's, so the rule always proposes.
    expect((await task({ title: "Window display", measure: { kind: "done" } }, PEOPLE.rosa)).measure?.proposed).toMatchObject({ kind: "moves" });
  });

  it("counts a purpose, a type or a LOOPS kind only for operators, and a type only when YouGrow keeps it", async () => {
    const purpose: MeasureInput = { kind: "used", counts: { purpose: "content_angle" }, look: { days: 14 } };
    expect(await add({ title: "Suggest an angle", brandId: LUMEN_US, measure: purpose })).toMatchObject({ ok: false, status: 403, error: "measure_operators" });
    expect(await add({ title: "Suggest an angle", brandId: LUMEN_US, measure: { kind: "used", counts: { type: "work_task" }, look: { days: 14 } } })).toMatchObject({ ok: false, error: "measure_operators" });
    expect(await add({ title: "Suggest an angle", brandId: LUMEN_US, measure: { kind: "used", counts: { loopKind: "vizzy_chat" }, look: { days: 14 } } })).toMatchObject({ ok: false, error: "measure_operators" });
    vi.stubEnv("LOOPS_OPERATOR_EMAILS", "nina@lumen.example");
    expect((await add({ title: "Suggest an angle", brandId: LUMEN_US, measure: purpose })).ok).toBe(true);
    expect((await add({ title: "Work tasks", brandId: LUMEN_US, measure: { kind: "used", counts: { type: "work_task" }, look: { days: 14 } } })).ok).toBe(true);
    expect(await add({ title: "Nothing", brandId: LUMEN_US, measure: { kind: "used", counts: { type: "no_such_type" }, look: { days: 14 } } })).toMatchObject({ ok: false, error: "type_not_built" });
  });

  it("counts a product event only from the brand's connected product, over 90 days at most", async () => {
    expect((await add({ title: "Templates", brandId: LUMEN_US, measure: event() })).ok).toBe(true);
    expect(await add({ title: "Templates", brandId: LUMEN_US, measure: event("pc_none") })).toMatchObject({ ok: false, error: "product_missing" });
    expect(await add({ title: "Templates", brandId: LUMEN_US, measure: event("pc_gone") })).toMatchObject({ ok: false, error: "product_missing" });
    expect(await add({ title: "Templates", brandId: LUMEN_US, measure: event("pc_lumen", PRODUCT_EVENT_MAX_DAYS + 1) })).toMatchObject({ ok: false, error: "product_look" });
    expect(await add({ title: "Templates", brandId: LUMEN_US, measure: { ...event(), look: { outputs: 10 } } as MeasureInput })).toMatchObject({ ok: false, error: "product_look" });
    expect(await add({ title: "Templates", brandId: LUMEN_EU, measure: event() })).toMatchObject({ ok: false, error: "product_missing" });
    // The then is checked the same way.
    expect(await add({ title: "Templates", brandId: LUMEN_US, measure: { kind: "runs_better", what: "speed", look: { days: 7 }, then: event("pc_none", 30) as never } })).toMatchObject({ ok: false, error: "product_missing" });
  });

  it("refuses a product event on a whole business task, except in a one brand organisation", async () => {
    expect(await add({ title: "Templates", brandId: null, measure: event() })).toMatchObject({ ok: false, error: "product_whole_business" });
    expect((await add({ title: "Orders online", measure: event("pc_fern") }, PEOPLE.priya)).ok).toBe(true);
  });

  it("moves a meaning, never a provider's or a date, with the brand's word only for conversions, starting from its better", async () => {
    const moves = (m: object) => add({ title: "Market stall", brandId: LUMEN_US, measure: { kind: "moves", look: { days: 30 }, ...m } as MeasureInput });
    expect(await moves({ meaning: "ga4Sessions" })).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
    expect(await moves({ meaning: "linkedinEngagement" })).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await moves({ meaning: "publishedAt" })).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await moves({ meaning: "openRate", word: "Opens" })).toMatchObject({ ok: false, error: "invalid_input" });
    const dir = async (meaning: string) => (value(await moves({ meaning })).task.task.measure as { direction: string }).direction;
    expect(await dir("conversions")).toBe("up");
    expect(await dir("searchPosition")).toBe("down");
    expect(await dir("declineShare")).toBe("down");
    expect(await dir("people")).toBe("up");
    expect((value(await moves({ meaning: "openRate", direction: "down" })).task.task.measure as { direction: string }).direction).toBe("down");
    expect((value(await moves({ meaning: "conversions", word: "Orders" })).task.task.measure as { word: string }).word).toBe("Orders");
  });

  it("never takes a then on Done is the win, never a then that is Done is the win, and the then looks later", async () => {
    const r = await add({ title: "Angles", brandId: LUMEN_US, measure: { kind: "used", counts: { none: "" }, look: { days: 30 }, then: { kind: "runs_better", what: "speed", look: { days: 14 } } } });
    expect(r).toMatchObject({ ok: false, error: "invalid_input", issues: [expect.objectContaining({ path: "measure.then.look" })] });
    expect((await add({ title: "Angles", brandId: LUMEN_US, measure: { kind: "used", counts: { none: "" }, look: { days: 14 }, then: { kind: "runs_better", what: "speed", look: { days: 30 } } } })).ok).toBe(true);
  });
});
