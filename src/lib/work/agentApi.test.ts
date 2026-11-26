import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_LOG, WORK_TASKS } from "@/lib/tenant";
import { asCard } from "@/components/admin/chat/cardData";
import type { TenantContext } from "@/lib/tenant/types";
import { numberKeys } from "@/lib/metrics/meanings";
import type { AgentAction } from "@/lib/types/agentAction";
import { agentDraftWorkDecision, agentDraftWorkLog, agentGetWork, agentSuggestWorkTask, agentWorkPost, fromLine, NOTE } from "./agentApi";
import { addLogEntry } from "./log";
import type { WorkResult } from "./result";
import { addTask, editTask, recordDecision } from "./service";
import { dismissSuggestion, proposeWorkSuggestion } from "./suggestions";
import { WORK_SUGGEST_ACTION } from "./suggestion";
import { LUMEN_EU, LUMEN_US, NINA, SAM } from "./testing/fixtures";
import { FERNHILL, makeWorld, PEOPLE, PRIYA, type World } from "./testing/world";
import type { WorkTask } from "./types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { CanvasCard } = await import("@/components/admin/chat/CanvasCard");

// Vizzy's Work tools, as the agent route runs them: the brand and the person come from the canvas
// token (source "agent", no email). Made-up Lumen (Lumen Notes in the United States, Lumen
// Europe, owned by Nina; Sam a member) and Fernhill Plants.
let w: World;
const agent = (tenantId: string, region: "us" | "eu", userId: string, role: "admin" | "member"): TenantContext => ({ tenantId, region, source: "agent", userId, role });
const NINA_AGENT = agent(LUMEN_US, "us", NINA, "admin");
const SAM_AGENT = agent(LUMEN_US, "us", SAM, "member");
const PRIYA_AGENT = agent(FERNHILL, "eu", PRIYA, "admin");

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const bodyOf = (r: { body: unknown }) => r.body as Body;

afterEach(() => vi.unstubAllEnvs());

let us: WorkTask;
let eu: WorkTask;
let whole: WorkTask;

beforeEach(async () => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
  const nina = await w.scope(PEOPLE.nina);
  us = value(await addTask(nina, { title: "Add a G2 listing", brandId: LUMEN_US, stage: "market", mustHave: true, typedLinks: [{ kind: "plan", url: "https://plans.lumen.example/g2", title: "G2 plan" }] }, w.deps)).task.task;
  eu = value(await addTask(nina, { title: "Register Lumen Europe for VAT", brandId: LUMEN_EU, stage: "billing_tax", measure: { kind: "done" } }, w.deps)).task.task;
  whole = value(await addTask(nina, { title: "SOC 2 for the whole business", brandId: null }, w.deps)).task.task;
});

describe("get_work", () => {
  it("reads every task an owner sees, in words, with no bare number anywhere", async () => {
    const r = await agentGetWork(NINA_AGENT, {}, w.deps);
    expect(r.status).toBe(200);
    const b = bodyOf(r);
    expect(b.tasks.map((t: Body) => t.ref).sort()).toEqual([`#${us.ref}`, `#${eu.ref}`, `#${whole.ref}`].sort());
    expect(b.tasks.find((t: Body) => t.ref === `#${us.ref}`)).toMatchObject({
      title: "Add a G2 listing",
      status: "To do",
      stage: "5 Market",
      brand: "Lumen Notes",
      mustHave: true,
      links: ["Plan · plans.lumen.example: G2 plan (Not approved yet)"],
      origin: "Added by nina on 20 Nov.",
      measure: null,
    });
    expect(b.tasks.find((t: Body) => t.ref === `#${eu.ref}`).measure).toMatchObject({ kind: "Done is the win" });
    expect(b.tasks.find((t: Body) => t.ref === `#${whole.ref}`)).toMatchObject({ brand: "Whole business" });
    expect(b).toMatchObject({ organisation: "Lumen", view: "every task in the organisation", brands: ["Lumen Notes", "Lumen Europe"], summary: "3 open, 1 Must have, 0 checks due.", note: NOTE });
    // The contract: every number in an agent answer has a meaning; Work's answers hold none.
    expect([...numberKeys(r.body)]).toEqual([]);
  });

  it("gives a member of a two brand organisation their own brand's tasks only, and no whole business tasks", async () => {
    const b = bodyOf(await agentGetWork(SAM_AGENT, {}, w.deps));
    expect(b.tasks.map((t: Body) => t.ref)).toEqual([`#${us.ref}`]);
    expect(b.view).toBe("Lumen Notes's tasks only");
    // Never the organisation's name in the brand view, as Plan and usage and the Work pages.
    expect(b.organisation).toBe("Lumen Notes");
    expect(JSON.stringify(b)).not.toContain('"Lumen"');
    expect(bodyOf(await agentGetWork(SAM_AGENT, { ref: String(us.ref) }, w.deps)).organisation).toBe("Lumen Notes");
    expect(await agentGetWork(SAM_AGENT, { ref: String(eu.ref) }, w.deps)).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it("filters by brand, stage and status in words, and refuses one it doesn't know", async () => {
    expect(bodyOf(await agentGetWork(NINA_AGENT, { brand: "lumen europe" }, w.deps)).tasks.map((t: Body) => t.ref)).toEqual([`#${eu.ref}`]);
    expect(bodyOf(await agentGetWork(NINA_AGENT, { brand: "whole business" }, w.deps)).tasks.map((t: Body) => t.ref)).toEqual([`#${whole.ref}`]);
    expect(bodyOf(await agentGetWork(NINA_AGENT, { stage: "Billing and tax" }, w.deps)).tasks.map((t: Body) => t.ref)).toEqual([`#${eu.ref}`]);
    expect(bodyOf(await agentGetWork(NINA_AGENT, { status: "done" }, w.deps)).tasks).toEqual([]);
    expect(await agentGetWork(NINA_AGENT, { brand: "Hearth Bakery" }, w.deps)).toMatchObject({ status: 400, body: { error: "brand_unknown", brands: ["Lumen Notes", "Lumen Europe"] } });
    expect(await agentGetWork(NINA_AGENT, { stage: "someday" }, w.deps)).toMatchObject({ status: 400, body: { error: "stage_unknown" } });
    expect(await agentGetWork(NINA_AGENT, { status: "later" }, w.deps)).toMatchObject({ status: 400, body: { error: "status_unknown" } });
  });

  it("reads one task in full: origin, plan approvals, the measure, decisions with who recommended which, and history", async () => {
    const nina = await w.scope(PEOPLE.nina);
    value(await recordDecision(nina, { ref: us.ref, plan: { url: "https://plans.lumen.example/g2" }, chosen: "b", why: "Needs pricing first" }, w.deps));
    value(await recordDecision(nina, { ref: us.ref, question: "Which listing first?", options: ["G2", "Capterra"], chosen: "a" }, w.deps, { recommended: { option: "b", by: { kind: "vizzy" }, reason: "Capterra reviews come faster" } }));
    const r = await agentGetWork(NINA_AGENT, { ref: `#${us.ref}` }, w.deps);
    const task = bodyOf(r).task;
    expect(task).toMatchObject({ ref: `#${us.ref}`, origin: expect.stringMatching(/^Added by nina on 20 Nov\.$/), links: ["Plan · plans.lumen.example: G2 plan (Change it)"], measure: null, check: null });
    expect(task.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ question: "Approve the plan", chosen: "nina chose b: Change it", recommended: null, planApproval: "Approves the plan at https://plans.lumen.example/g2", why: "Needs pricing first" }),
      expect.objectContaining({ question: "Which listing first?", recommended: "Vizzy recommended b: Capterra. Capterra reviews come faster", chosen: "nina chose a: G2", agreed: false }),
    ]));
    expect(task.decisions).toHaveLength(2);
    expect(task.history[0]).toMatch(/^nina /);
    expect(bodyOf(r).link).toBe(`/admin/work/${us.ref}`);
    expect([...numberKeys(r.body)]).toEqual([]);
    const done = bodyOf(await agentGetWork(NINA_AGENT, { ref: String(eu.ref) }, w.deps)).task;
    expect(done.measure).toMatchObject({ kind: "Done is the win" });
  });

  it("reads today's Log: workstreams in flight with Day N, entries, and who wrote them", async () => {
    value(await addLogEntry(await w.scope(PEOPLE.sam), { workstream: "Pricing page", state: "doing", note: "Copy done" }, w.deps));
    const log = bodyOf(await agentGetWork(NINA_AGENT, {}, w.deps)).log;
    expect(log).toMatchObject({ today: true, inFlight: [{ workstream: "Pricing page", state: "In progress", note: "Copy done", since: "Day 1", by: "sam" }] });
    expect(log.entries).toEqual([expect.objectContaining({ workstream: "Pricing page", by: "sam", drafted: false })]);
  });

  it("returns the suggestions waiting in Review, and those dismissed lately with why and whether Vizzy may come back", async () => {
    const nina = await w.scope(PEOPLE.nina);
    const make = async (title: string) => value(await proposeWorkSuggestion(nina, { task: { title, description: "", stage: "market", brandId: LUMEN_US, typedLinks: [], measure: null, proposed: null, from: "from your numbers", why: "" } }, w.deps)).action!;
    await make("Write a comparison page");
    const later = await make("Run a webinar");
    const never = await make("Buy a billboard");
    const quiet = await make("Start a podcast");
    value(await dismissSuggestion(nina, { actionId: later.id, rev: 1, why: "not_now" }, w.deps));
    value(await dismissSuggestion(nina, { actionId: never.id, rev: 1, why: "not_for_us" }, w.deps));
    value(await dismissSuggestion(nina, { actionId: quiet.id, rev: 1 }, w.deps));
    const b = bodyOf(await agentGetWork(NINA_AGENT, {}, w.deps));
    expect(b.suggestionsWaiting).toEqual([expect.objectContaining({ title: "Write a comparison page", stage: "5 Market" })]);
    const byTitle = Object.fromEntries(b.dismissedLately.map((d: Body) => [d.title, d]));
    expect(byTitle["Run a webinar"]).toEqual({ title: "Run a webinar", why: "Not now", on: "20 Nov", again: "Vizzy may suggest it again from 20 Dec." });
    expect(byTitle["Buy a billboard"]).toMatchObject({ why: "Not for us", again: "Vizzy won't suggest it again." });
    expect(byTitle["Start a podcast"]).toMatchObject({ why: "No reason given", again: "Vizzy won't suggest it again." });
    // After 30 days, Not now lets it back now.
    w.at("2026-12-21T09:00:00.000Z");
    const after = bodyOf(await agentGetWork(NINA_AGENT, {}, w.deps));
    expect(after.dismissedLately.find((d: Body) => d.title === "Run a webinar").again).toBe("Vizzy may suggest it again from 21 Dec.");
  });

  it("lists the suggestions dismissed or waiting in the chats of every brand the person sees", async () => {
    const whole = { title: "Register the business", description: "", stage: "set_up", brandId: null, typedLinks: [], measure: { kind: "done" }, proposed: null, from: "from your chat with Vizzy", why: "" };
    const a = value(await proposeWorkSuggestion(await w.scope(PEOPLE.nina), { task: whole }, w.deps)).action!;
    value(await dismissSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1, why: "not_for_us" }, w.deps));
    value(await proposeWorkSuggestion(await w.scope(PEOPLE.nina), { task: { ...whole, title: "Open a business bank account" } }, w.deps));
    const b = bodyOf(await agentGetWork(agent(LUMEN_EU, "eu", NINA, "admin"), {}, w.deps));
    expect(b.dismissedLately).toEqual([expect.objectContaining({ title: "Register the business", why: "Not for us", again: "Vizzy won't suggest it again." })]);
    expect(b.suggestionsWaiting).toEqual([expect.objectContaining({ title: "Open a business bank account", brand: "Whole business" })]);
    // From Lumen Europe's chat, the dismissed one isn't made again.
    expect(bodyOf(await agentSuggestWorkTask(agent(LUMEN_EU, "eu", NINA, "admin"), { tool: "suggest_work_task", title: "Register the business", brand: "whole business", stage: "Set up" }, w.deps))).toMatchObject({ outcome: "dismissed" });
  });

  it("gives each task and Log row its id, which suggest_work_task takes back as evidence", async () => {
    value(await addLogEntry(await w.scope(PEOPLE.sam), { workstream: "Pricing research", state: "waiting", note: "On tonight's runs" }, w.deps));
    const b = bodyOf(await agentGetWork(NINA_AGENT, {}, w.deps));
    const task = b.tasks.find((t: Body) => t.ref === `#${us.ref}`);
    expect(task.id).toBe(us.id);
    expect(b.log.entries[0].id).toMatch(/^wl_/);
    expect(b.log.inFlight[0]).toMatchObject({ id: b.log.entries[0].id, workstream: "Pricing research" });
    const r = bodyOf(
      await agentSuggestWorkTask(NINA_AGENT, { tool: "suggest_work_task", title: "Compare three pricing pages", evidence: [{ kind: "work_log", ref: b.log.inFlight[0].id }, { kind: "work_task", ref: task.id }] }, w.deps),
    );
    const kept = w.us.raw("agent_actions", r.card.id) as unknown as AgentAction;
    expect(kept.signals).toEqual([{ kind: "work_log", ref: b.log.inFlight[0].id }, { kind: "work_task", ref: us.id }]);
    expect((kept.proposal as Body).task.from).toBe("from today's log: Pricing research");
    expect(bodyOf(await agentGetWork(NINA_AGENT, { ref: String(us.ref) }, w.deps)).task.id).toBe(us.id);
  });

  it("counts a due check it lists, as the task page does, so its line never says it will count one that is due", async () => {
    w.us.seed("product_connections", "pc_lumen", { tenantId: LUMEN_US, name: "Lumen app", status: "active", catalog: { events: [] } });
    const nina = await w.scope(PEOPLE.nina);
    const t = value(await addTask(nina, { title: "Templates", brandId: LUMEN_US, status: "done", measure: { kind: "used", counts: { productEvent: { connectionId: "pc_lumen", event: "note_from_template" } }, look: { days: 7 } } }, w.deps)).task.task;
    for (let i = 0; i < 3; i++) {
      w.us.seed("product_events", `pe_${i}`, { tenantId: LUMEN_US, connectionId: "pc_lumen", type: "track", event: "note_from_template", receivedAt: `2026-11-2${2 + i}T12:00:00.000Z` });
    }
    w.at("2026-11-27T15:00:00.000Z");
    const b = bodyOf(await agentGetWork(NINA_AGENT, {}, w.deps));
    expect(b.log.checksDue).toEqual([{ task: `#${t.ref} Templates`, line: "Work counted 3 note_from_template events from Lumen Notes' product since 20 Nov." }]);
    expect((w.us.raw(WORK_TASKS, t.id) as unknown as WorkTask).check?.counted).toMatchObject({ n: 3 });
  });

  it("never shows Vizzy a loop line, which only operators see", async () => {
    vi.stubEnv("LOOPS_OPERATOR_EMAILS", "nina@lumen.example");
    vi.stubEnv("LOOPS_SOURCE_REPO", "Lumen-Example/notes-app");
    const t = value(await addTask(await w.scope(PEOPLE.nina), { title: "New sign in", brandId: LUMEN_US, typedLinks: [{ kind: "pull_request", provider: "github", repo: "Lumen-Example/notes-app", number: 412 }, { kind: "loop_line", loopKind: "vizzy_chat" }] }, w.deps)).task.task;
    const listed = bodyOf(await agentGetWork(NINA_AGENT, {}, w.deps)).tasks.find((x: Body) => x.ref === `#${t.ref}`);
    expect(listed.links).toEqual(["Pull request: #412 in Lumen-Example/notes-app"]);
    expect(JSON.stringify(bodyOf(await agentGetWork(NINA_AGENT, { ref: String(t.ref) }, w.deps)))).not.toMatch(/loop/i);
  });

  it("says a measure or a check was set in a task's history, and took off only when it was", async () => {
    const nina = await w.scope(PEOPLE.nina);
    value(await editTask(nina, us.ref, { measure: { kind: "moves", meaning: "conversions", word: "Orders", look: { days: 14 } } }, w.deps));
    value(await editTask(nina, us.ref, { check: { kind: "date", day: "2026-12-01" } }, w.deps));
    const history = bodyOf(await agentGetWork(NINA_AGENT, { ref: String(us.ref) }, w.deps)).task.history as string[];
    expect(history[0]).toMatch(/^nina set the check \(/);
    expect(history[1]).toMatch(/^nina set how we'll know it worked \(/);
    value(await editTask(nina, us.ref, { check: null }, w.deps));
    value(await editTask(nina, us.ref, { measure: null }, w.deps));
    const after = bodyOf(await agentGetWork(NINA_AGENT, { ref: String(us.ref) }, w.deps)).task.history as string[];
    expect(after[0]).toMatch(/^nina took off how we'll know it worked \(/);
    expect(after[1]).toMatch(/^nina cleared the check \(/);
  });

  it("says why when the brand's organisation doesn't list it back", async () => {
    w.control.seed("tenants", "ten_drift", { tenantName: "Drift", rootDomain: "drift.example", ownerId: NINA, status: "active", region: "us", allowedOrigins: [], createdAt: "2026-11-20T09:00:00.000Z", updatedAt: "2026-11-20T09:00:00.000Z", organisationId: "org_ten_lumen" });
    expect(await agentGetWork(agent("ten_drift", "us", NINA, "admin"), {}, w.deps)).toMatchObject({ status: 409, body: { error: "no_organisation" } });
  });
});

describe("suggest_work_task", () => {
  const suggest = (body: Record<string, unknown>, who: TenantContext = NINA_AGENT) => agentSuggestWorkTask(who, { tool: "suggest_work_task", ...body }, w.deps);

  it("makes a suggestion that waits in Review, for the brand in chat, with where it came from worked out on the server", async () => {
    const entry = value(await addLogEntry(await w.scope(PEOPLE.sam), { workstream: "Competitor pricing research", state: "waiting", note: "On tonight's runs" }, w.deps)).row;
    const r = await suggest({
      title: "Check the team plan test accounts",
      stage: "Build",
      measureKind: "runs_better",
      measure: { kind: "runs_better", what: "errors", look: { days: 7 } },
      measureReason: "It checks that a nightly run works.",
      why: "Sam logged it as waiting on tonight's runs.",
      evidence: [
        { kind: "work_log", ref: entry.id },
        { kind: "metric", ref: "searchClicks" },
        { kind: "work_task", ref: "wt_aaaaaaaaaaaaaaaaaaaa" },
        { kind: "gossip", ref: "x" },
      ],
    });
    expect(r.status).toBe(200);
    const b = bodyOf(r);
    expect(b).toMatchObject({ outcome: "suggested", card: { kind: "work_suggestion", url: "/admin/approvals#work_suggestion", cta: "Open Review", note: "Nothing goes on Work until someone adds it in Review." } });
    const a = w.us.raw("agent_actions", b.card.id) as unknown as AgentAction;
    expect(a).toMatchObject({
      action: WORK_SUGGEST_ACTION,
      clearDetailsOnClose: false,
      requestedBy: { type: "member", id: NINA },
      proposal: { task: { title: "Check the team plan test accounts", stage: "build", brandId: LUMEN_US, from: "from today's log: Competitor pricing research", proposed: { kind: "runs_better", reason: "It checks that a nightly run works." } } },
    });
    // Only evidence that is a signal ref, and Work rows of this organisation, are kept.
    expect(a.signals).toEqual([
      { kind: "work_log", ref: entry.id },
      { kind: "metric", ref: "searchClicks" },
    ]);
    expect((a.proposal as Body).task).not.toHaveProperty("mustHave");
    expect([...numberKeys(r.body)]).toEqual([]);
    // The same suggestion again waits; dismissed with Not for us, it never comes back.
    expect(bodyOf(await suggest({ title: "Check the team plan test accounts", stage: "Build", measureKind: "runs_better", measure: { kind: "runs_better", what: "errors", look: { days: 7 } }, measureReason: "It checks that a nightly run works." }))).toMatchObject({ outcome: "waiting" });
  });

  it("never sets Must have", async () => {
    for (const key of ["mustHave", "must_have"]) {
      expect(await suggest({ title: "Register the business", [key]: true })).toMatchObject({ status: 400, body: { error: "suggestion_must_have" } });
    }
    expect(w.us.dump("agent_actions")).toEqual([]);
  });

  it("needs a reason with a kind of win, and checks the brand and stage it names", async () => {
    expect(await suggest({ title: "Register the business", measureKind: "done" })).toMatchObject({ status: 400, body: { error: "suggestion_reason" } });
    expect(await suggest({ title: "Register the business", brand: "Hearth Bakery" })).toMatchObject({ status: 400, body: { error: "brand_unknown" } });
    expect(await suggest({ title: "Register the business", stage: "Later" })).toMatchObject({ status: 400, body: { error: "stage_unknown" } });
    // Sam, a member, sees and suggests for Lumen Notes only, and never for the whole business.
    expect(await suggest({ title: "Translate the site", brand: "Lumen Europe" }, SAM_AGENT)).toMatchObject({ status: 400, body: { error: "brand_unknown", brands: ["Lumen Notes"] } });
    expect(await suggest({ title: "Translate the site", brand: "whole business" }, SAM_AGENT)).toMatchObject({ status: 403, body: { error: "whole_business_owners" } });
    // A brand kept in another region can't be added from this chat's Review in one transaction.
    expect(await suggest({ title: "Translate the site", brand: "Lumen Europe" })).toMatchObject({ status: 409, body: { error: "suggestion_other_region" } });
  });

  it("says when the same suggestion was dismissed, and when Not now lets it back", async () => {
    const nina = await w.scope(PEOPLE.nina);
    const first = bodyOf(await suggest({ title: "Run a webinar", stage: "Market" }));
    value(await dismissSuggestion(nina, { actionId: first.card.id, rev: 1, why: "not_now" }, w.deps));
    expect(bodyOf(await suggest({ title: "Run a webinar", stage: "Market" }))).toEqual({ outcome: "not_now", message: "Someone dismissed that suggestion with Not now. Vizzy can suggest it again from 20 Dec." });
    const second = bodyOf(await suggest({ title: "Buy a billboard" }));
    value(await dismissSuggestion(nina, { actionId: second.card.id, rev: 1, why: "wrong" }, w.deps));
    expect(bodyOf(await suggest({ title: "Buy a billboard" }))).toMatchObject({ outcome: "dismissed" });
  });

  it("works out where it came from", () => {
    const base = { logRows: [], stage: null, today: "2026-11-20", timeZone: "UTC" };
    expect(fromLine({ ...base, refs: [{ kind: "data_signal", ref: "ds_1" }] })).toBe("from your numbers");
    expect(fromLine({ ...base, refs: [{ kind: "brand_note", ref: "bn_1" }] })).toBe("from What we've seen");
    expect(fromLine({ ...base, refs: [], stage: "billing_tax" })).toBe("as the next step for Billing and tax");
    expect(fromLine({ ...base, refs: [] })).toBe("from your chat with Vizzy");
  });
});

describe("draft_work_log and draft_work_decision", () => {
  it("drafts a note whose card opens the Log to save it", async () => {
    const r = await agentDraftWorkLog(NINA_AGENT, { tool: "draft_work_log", workstream: "Pricing page", state: "Done", note: "Copy done", task: `#${us.ref}` }, w.deps);
    const b = bodyOf(r);
    expect(b).toMatchObject({ outcome: "drafted", card: { kind: "work_log_draft", title: "Log note, drafted", subtitle: "Pricing page", url: `/admin/work/log?draft=${b.card.id}`, cta: "Save to today's log", stats: [{ label: "", value: "Done" }] } });
    expect(w.us.dump(WORK_LOG).filter((x) => x.kind === "entry")).toEqual([]);
    expect([...numberKeys(r.body)]).toEqual([]);
  });

  it("drafts a decision whose card opens the task, with Vizzy's pick", async () => {
    const b = bodyOf(await agentDraftWorkDecision(NINA_AGENT, { tool: "draft_work_decision", task: us.ref, question: "Which listing first?", options: ["G2", "Capterra"], recommended: "Capterra", reason: "Reviews come faster." }, w.deps));
    expect(b).toMatchObject({
      outcome: "drafted",
      card: { kind: "work_decision_draft", subtitle: `#${us.ref} Which listing first?`, url: `/admin/work/${us.ref}?decision=${b.card.id}#decisions`, cta: "Choose", stats: [{ label: "", value: "Vizzy's pick: Capterra" }] },
      pick: "Vizzy's pick: Capterra. Reviews come faster.",
    });
  });

  it("draw in the chat as they read: each stat its value then its label, or a sentence on its own", async () => {
    const line = (body: Body) => {
      const card = asCard(body);
      if (!card) throw new Error("no card");
      // The card's line under its title: the subtitle and the stats.
      return renderToStaticMarkup(createElement(CanvasCard, { card })).match(/<div class="text-xs text-neutral-500">(.*?)<\/div>/)![1]!.replace(/&#x27;/g, "'");
    };
    const suggested = bodyOf(
      await agentSuggestWorkTask(NINA_AGENT, {
        tool: "suggest_work_task",
        title: "Answer the offline question on the site",
        stage: "Market",
        measureKind: "moves",
        measure: { kind: "moves", meaning: "conversions", direction: "up", look: { days: 14 } },
        measureReason: "It answers a question people search for.",
        why: "People asked it.",
      }, w.deps),
    );
    expect(line(suggested)).toBe("Answer the offline question on the site · 5 Market stage · Moves a number: conversions up, 14 days after it's done.");
    const logged = bodyOf(await agentDraftWorkLog(NINA_AGENT, { tool: "draft_work_log", workstream: "Supplier calls", state: "Done" }, w.deps));
    expect(line(logged)).toBe("Supplier calls · Done");
    const decided = bodyOf(await agentDraftWorkDecision(NINA_AGENT, { tool: "draft_work_decision", task: us.ref, question: "Which supplier first?", options: ["Fernhill Pots", "Lumen Clay"], recommended: "Fernhill Pots", reason: "Nearer." }, w.deps));
    expect(line(decided)).toBe(`#${us.ref} Which supplier first? · Vizzy's pick: Fernhill Pots`);
    const unpicked = bodyOf(await agentDraftWorkDecision(NINA_AGENT, { tool: "draft_work_decision", task: us.ref, question: "Which van first?", options: ["The small one", "The big one"] }, w.deps));
    expect(line(unpicked)).toBe(`#${us.ref} Which van first? · Vizzy didn't pick one.`);
  });

  it("never drafts Approve the plan: refused before anything is read or written", async () => {
    for (const body of [
      { tool: "draft_work_decision", task: us.ref, question: "Approve the plan", options: ["Approve", "Change it", "Not now"], recommended: "a", reason: "It reads well." },
      { tool: "draft_work_decision", task: us.ref, question: "approve the plan?", options: ["Approve", "Not now"] },
      { tool: "draft_work_decision", task: us.ref, question: "Ship it?", options: ["Yes", "No"], plan: { url: "https://plans.lumen.example/g2" } },
    ]) {
      expect(await agentWorkPost(NINA_AGENT, body, w.deps)).toMatchObject({ status: 400, body: { error: "plan_drafted" } });
    }
    expect(w.us.dump("agent_actions")).toEqual([]);
  });

  it("names an unknown tool", async () => {
    expect(await agentWorkPost(NINA_AGENT, { tool: "add_task" }, w.deps)).toMatchObject({ status: 400, body: { error: "invalid_input" } });
    expect(await agentWorkPost(PRIYA_AGENT, null, w.deps)).toMatchObject({ status: 400 });
  });
});
