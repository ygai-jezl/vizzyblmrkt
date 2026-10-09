import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { authorPersonPlan } from "@/lib/canvas/kinds/personPlan";
import { getCanvasKind } from "@/lib/canvas/registry";
import { eraseProductUser } from "@/lib/connect/erase";
import { suppressEmail } from "@/lib/email/suppression";
import { enrolUser, enrolmentDocId } from "@/lib/lifecycle/enrol";
import { prepareDueDrafts } from "@/lib/lifecycle/prepare";
import { processEnrolment } from "@/lib/lifecycle/runner";
import { listApprovals, type ApprovalView } from "@/lib/lifecycle/approvals";
import { draftDocId } from "@/lib/lifecycle/drafts";
import { CONNECTION_ID, T0, contextStub, ctx, productContext, publishOnboarding, seedUser, seedWorld, sendStub, system } from "@/lib/lifecycle/testing/fixtures";
import { exportPerson } from "./personExport";
import { loadPersonBrief } from "./personBrief";
import { personScrubber } from "./identityScrubber";
import { approvePlan, dropPlan, getPersonPlan, personPlanDocId, planGuidance, savePlanDraft } from "./personPlans";
import { loadPersonRecord } from "./personRecord";

const MIN = 60_000;
const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const agent: TenantContext = { ...ctx, source: "agent" };
const PLAN = { goal: "Connect their site", angle: "One short email with one link. Lead with what they will see once it is connected.", next: ["Send the next reminder with this angle", "Review in a week"], reviewOn: "2026-10-01" };

const FLAGS = ["AUDIENCE_PERSON_VIEW", "LIFECYCLE_ENABLED", "LIFECYCLE_PERSON_BRIEF", "LIFECYCLE_CHAT_AUTHORING_ENABLED", "LIFECYCLE_PERSON_PLANS", "LIFECYCLE_AI_DRAFTS_ENABLED"];
beforeEach(() => {
  for (const f of FLAGS) process.env[f] = "true";
  process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
  process.env.LIFECYCLE_MODE_CEILING = "live";
});
afterEach(() => {
  for (const f of [...FLAGS, "EMAIL_LINK_ORIGIN", "LIFECYCLE_MODE_CEILING"]) delete process.env[f];
});

function world() {
  const db = new FakeFirestore();
  seedWorld(db);
  const user = seedUser(db, "user_8841", { email: "priya.raman@harbour.test", emailNormalized: "priya.raman@harbour.test", firstName: "Priya", lastName: "Raman" });
  return { db, user };
}

describe("a person's plan", () => {
  it("is saved as a draft, and only becomes the plan in force when staff approve it", async () => {
    const { db, user } = world();
    const saved = await savePlanDraft(agent, user.id, PLAN, { db, nowMs: T0, by: "agent" });
    expect(saved.ok && saved.value).toMatchObject({ id: personPlanDocId(user.id), productUserId: user.id, connectionId: CONNECTION_ID, approved: null, draft: { ...PLAN, by: "agent", at: iso(T0) } });

    const approved = await approvePlan(ctx, user.id, { db, nowMs: T0 + HOUR, draftAt: iso(T0) });
    expect(approved.ok && approved.value).toMatchObject({ draft: null, approved: { ...PLAN, by: "agent", approvedBy: ctx.email, at: iso(T0 + HOUR) } });
    // Nothing left to approve.
    expect(await approvePlan(ctx, user.id, { db, draftAt: iso(T0) })).toMatchObject({ ok: false, status: 409, error: "no_draft" });

    // A new draft waits beside the plan in force until it is approved or thrown away.
    await savePlanDraft(ctx, user.id, { ...PLAN, goal: "Run their first report" }, { db, by: "human" });
    expect(await getPersonPlan(ctx, user.id, db)).toMatchObject({ draft: { goal: "Run their first report", by: "human" }, approved: { goal: PLAN.goal } });
    expect((await dropPlan(ctx, user.id, "draft", { db })).ok).toBe(true);
    expect(await getPersonPlan(ctx, user.id, db)).toMatchObject({ draft: null, approved: { goal: PLAN.goal } });
    expect((await dropPlan(ctx, user.id, "approved", { db })).ok).toBe(true);
    expect(await dropPlan(ctx, user.id, "approved", { db })).toMatchObject({ ok: false, error: "no_plan" });
  });

  it("approves only the draft the approver read", async () => {
    const { db, user } = world();
    await savePlanDraft(ctx, user.id, PLAN, { db, nowMs: T0, by: "human" });
    // Vizzy saves another draft while the first is still on the admin's screen.
    await savePlanDraft(agent, user.id, { ...PLAN, goal: "Upgrade to Pro" }, { db, nowMs: T0 + MIN, by: "agent" });
    expect(await approvePlan(ctx, user.id, { db, draftAt: iso(T0) })).toMatchObject({ ok: false, status: 409, error: "draft_changed" });
    expect(await getPersonPlan(ctx, user.id, db)).toMatchObject({ approved: null, draft: { goal: "Upgrade to Pro", by: "agent" } });
    // Having seen the new one, they can approve it.
    expect((await approvePlan(ctx, user.id, { db, draftAt: iso(T0 + MIN) })).ok).toBe(true);
  });

  it("can't hold an address or their full name", async () => {
    const { db, user } = world();
    for (const bad of [
      { ...PLAN, angle: "Priya Raman opens everything; keep it short." },
      { ...PLAN, goal: "Get raman, priya to connect the site" },
      { ...PLAN, next: ["Email priya.raman@harbour.test directly"] },
      { ...PLAN, next: ["Copy in support@fernlight.test"] },
    ]) {
      expect(await savePlanDraft(ctx, user.id, bad, { db })).toMatchObject({ ok: false, status: 422, error: "names_the_person" });
    }
    expect(await getPersonPlan(ctx, user.id, db)).toBeNull();
    expect(await savePlanDraft(ctx, user.id, { ...PLAN, angle: "" }, { db })).toMatchObject({ ok: false, status: 400, error: "invalid_plan" });
    expect(await savePlanDraft(ctx, "pu_nobody", PLAN, { db })).toMatchObject({ ok: false, status: 404 });
    expect(await savePlanDraft({ ...ctx, tenantId: "ten_other" }, user.id, PLAN, { db })).toMatchObject({ ok: false, status: 404 });
  });

  it("keeps a first name as staff wrote it, and takes it out for Vizzy and the AI line", async () => {
    const { db, user } = world();
    const named = { ...PLAN, angle: "Priya opens everything; keep it short." };
    expect((await savePlanDraft(ctx, user.id, named, { db, nowMs: T0 })).ok).toBe(true);
    const page = await loadPersonRecord(ctx, user.id, { db });
    // Their page shows the plan as written, and which word won't be seen.
    expect(page.found && page.person.plan).toMatchObject({ draft: { angle: named.angle }, unseen: { draft: ["Priya"], approved: [] } });
    const brief = await loadPersonBrief(ctx, user.id, { db });
    expect(brief.found && brief.brief.plan?.draft?.angle).toBe("[name] opens everything; keep it short.");
    const scrub = personScrubber(user);
    expect(planGuidance(named, scrub)).toBe("Goal: Connect their site\nHow to put it: [name] opens everything; keep it short.");
    // A person whose name is an everyday word can have a plan like anyone else.
    const will = seedUser(db, "user_31", { email: "team@harbour.test", emailNormalized: "team@harbour.test", firstName: "Will", lastName: "May" });
    const plan = { ...PLAN, angle: "We will lead with the benefit; they may want the team plan." };
    expect((await savePlanDraft(ctx, will.id, plan, { db })).ok).toBe(true);
    expect(planGuidance(plan, personScrubber(will))).toContain(plan.angle);
  });

  it("is on their page and in Vizzy's brief, and goes when they're erased", async () => {
    const { db, user } = world();
    await savePlanDraft(agent, user.id, PLAN, { db, nowMs: T0, by: "agent" });
    const page = await loadPersonRecord(ctx, user.id, { db });
    expect(page.found && page.person.plan).toMatchObject({ draft: { goal: PLAN.goal }, approved: null });
    const brief = await loadPersonBrief(ctx, user.id, { db });
    expect(brief.found && brief.brief.plan).toEqual({ inForce: null, draft: { ...PLAN, writtenBy: "agent" } });
    const exported = await exportPerson(ctx, user.id, { db });
    expect(exported.found && exported.document.plans).toHaveLength(1);
    expect(exported.found && exported.document).toMatchObject({ complete: true });
    expect(exported.found && "truncated" in exported.document).toBe(false);
    // A section that comes back full says so: the file never passes for the whole of it.
    const cut = await exportPerson(ctx, user.id, { db, limits: { plans: 1 } });
    expect(cut.found && cut.document).toMatchObject({ complete: false, truncated: { plans: "only the first 1 are here: there may be more" } });
    // An id that could never be one of ours is nobody, not an error.
    expect(await exportPerson(ctx, "pu_a/b", { db })).toEqual({ found: false });
    expect(await getPersonPlan(ctx, "pu_a/b", db)).toBeNull();
    expect(await savePlanDraft(ctx, "pu_a/b", PLAN, { db })).toMatchObject({ ok: false, status: 404 });
    expect(await approvePlan(ctx, "pu_a/b", { db, draftAt: iso(T0) })).toMatchObject({ ok: false, status: 409 });
    expect(await dropPlan(ctx, "pu_a/b", "draft", { db })).toMatchObject({ ok: false, status: 409 });

    await eraseProductUser(ctx, CONNECTION_ID, user.id, db);
    expect(await getPersonPlan(ctx, user.id, db)).toBeNull();
    expect(await forTenant(ctx, db).personPlans.find()).toEqual([]);
  });

  it("is left off their page and out of the brief while plans are switched off", async () => {
    const { db, user } = world();
    await savePlanDraft(ctx, user.id, PLAN, { db });
    delete process.env.LIFECYCLE_PERSON_PLANS;
    const page = await loadPersonRecord(ctx, user.id, { db });
    expect(page.found && "plan" in page.person).toBe(false);
    const brief = await loadPersonBrief(ctx, user.id, { db });
    expect(brief.found && "plan" in brief.brief).toBe(false);
  });
});

describe("the person_plan canvas kind (Vizzy)", () => {
  const input = (personId: string, over: Record<string, unknown> = {}) => ({ kind: "person_plan", action: "save_draft", scope: { personId }, goal: PLAN.goal, angle: PLAN.angle, next: PLAN.next, reviewInDays: 7, ...over });

  it("saves a draft for staff to approve, and says so", async () => {
    const { db, user } = world();
    expect(getCanvasKind("person_plan")?.label).toBe("plan for one person");
    const out = await authorPersonPlan({ ctx: agent, input: input(user.id), brief: "" }, { db, nowMs: T0 });
    expect(out).toMatchObject({ ok: true, id: personPlanDocId(user.id), status: "draft", url: `/admin/crm/people/${user.id}` });
    expect(out.ok && out.card).toMatchObject({ kind: "person_plan", cta: "Open their page", stats: [{ label: "next steps", value: 2 }] });
    expect(out.ok && out.summary).toContain("Nothing changes until someone on your team approves it");
    // Seven days from Monday 21 September.
    expect(await getPersonPlan(ctx, user.id, db)).toMatchObject({ approved: null, draft: { by: "agent", reviewOn: "2026-09-28" } });
  });

  it("plans nothing for someone who can't be emailed, or a plan that names them, or for a member, or while it's off", async () => {
    const { db, user } = world();
    expect(await authorPersonPlan({ ctx: agent, input: input(user.id, { angle: "Tell Priya Raman it takes two minutes." }), brief: "" }, { db })).toMatchObject({ ok: false, status: 422, error: "names_the_person" });
    // Writing a plan is for admins on the person's page, so it is through Vizzy too; a token with no role is refused.
    for (const role of ["member", undefined] as const) {
      expect(await authorPersonPlan({ ctx: { ...agent, role }, input: input(user.id), brief: "" }, { db })).toMatchObject({ ok: false, status: 403, error: "forbidden" });
    }
    expect(await getPersonPlan(ctx, user.id, db)).toBeNull();
    expect(await authorPersonPlan({ ctx: agent, input: input(user.id, { goal: 7 }), brief: "" }, { db })).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
    await suppressEmail(system, { email: user.email!, reason: "unsubscribe", source: "footer" }, db);
    expect(await authorPersonPlan({ ctx: agent, input: input(user.id), brief: "" }, { db })).toMatchObject({ ok: false, status: 409, error: "cannot_email" });
    // Staff can still write one down for themselves.
    expect((await savePlanDraft(ctx, user.id, PLAN, { db, by: "human" })).ok).toBe(true);
    delete process.env.LIFECYCLE_PERSON_PLANS;
    expect(await authorPersonPlan({ ctx: agent, input: input(user.id), brief: "" }, { db })).toMatchObject({ ok: false, status: 503, error: "person_plans_unavailable" });
  });
});

describe("an approved plan steers the person's AI line", () => {
  const LINE = "That's a strong start — connecting your site shows where to focus next.";

  async function booked(opts: { plan: "approved" | "draft" | "none"; body?: typeof PLAN }) {
    const db = new FakeFirestore();
    seedWorld(db);
    const user = seedUser(db, "alex");
    const { journey, version } = await publishOnboarding(db, { testUserIds: ["alex"] });
    await enrolUser(system, { journey, version, user, source: "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 });
    const id = enrolmentDocId(journey.id, user.id);
    if (opts.plan !== "none") await savePlanDraft(agent, user.id, opts.body ?? PLAN, { db, nowMs: T0, by: "agent" });
    if (opts.plan === "approved") await approvePlan(ctx, user.id, { db, nowMs: T0 + MIN, draftAt: iso(T0) });
    let now = T0;
    const prompts: string[] = [];
    const deps = {
      db,
      now: () => now,
      send: sendStub().send,
      fetchContext: contextStub(() => productContext()).fetchContext,
      generate: async (prompt: string) => {
        prompts.push(prompt);
        return JSON.stringify({ line: LINE, subject: "" });
      },
    };
    await processEnrolment(system, id, deps);
    now = T0 + 15 * MIN;
    expect(await processEnrolment(system, id, deps)).toBe("sent");
    const sendAt = Date.parse((await forTenant(system, db).lifecycleEnrolments.getById(id))!.nextRunAt!);
    now = sendAt - 12 * HOUR;
    expect(await prepareDueDrafts(system, deps)).toEqual({ prepared: 1, fallback: 0, superseded: 0 });
    const draft = (await forTenant(system, db).lifecycleDrafts.getById(draftDocId(id, "reminders", "r1")))!;
    return { db, user, prompts, draft, now };
  }

  it("puts the goal and the angle in the line's prompt, and marks the line as shaped by it", async () => {
    const w = await booked({ plan: "approved" });
    expect(w.prompts[0]).toContain("<plan>\nGoal: Connect their site\nHow to put it: One short email with one link.");
    // Fenced like the prompt's other operator input, so a plan can't give the model orders.
    expect(w.prompts[0]).toMatch(/UNTRUSTED operator input[^\n]*\n<plan>/);
    expect(w.draft).toMatchObject({ status: "awaiting_approval", aiLine: LINE, planAt: iso(T0 + MIN) });
    // Staff reviewing the line see what shaped it, and can open the person.
    const queue = (await listApprovals(ctx, { view: "waiting" }, w.db, w.now)).body as { drafts: ApprovalView[] };
    expect(queue.drafts[0]).toMatchObject({ planned: true, personHref: `/admin/crm/people/${w.user.id}` });
  });

  it("reads the plan without their name, even when staff wrote it in", async () => {
    // The fixture's person is Alex (and the product's id for them is "alex").
    const w = await booked({ plan: "approved", body: { ...PLAN, angle: "Alex likes it short: one link, no preamble." } });
    const plan = /<plan>[\s\S]*?<\/plan>/.exec(w.prompts[0]!)?.[0] ?? "";
    expect(plan).toContain("likes it short: one link, no preamble.");
    expect(plan).not.toMatch(/alex/i);
  });

  it("uses only a plan staff approved, and none while plans are off", async () => {
    const drafted = await booked({ plan: "draft" });
    expect(drafted.prompts[0]).not.toContain("<plan>");
    expect(drafted.draft.planAt ?? null).toBeNull();
    const none = await booked({ plan: "none" });
    expect(none.prompts[0]).not.toContain("<plan>");

    delete process.env.LIFECYCLE_PERSON_PLANS;
    const off = await booked({ plan: "approved" });
    // With plans off the prompt is, to the letter, the one written with no plan at all.
    expect(off.prompts[0]).toBe(none.prompts[0]);
    expect(off.draft.planAt ?? null).toBeNull();
  });
});
