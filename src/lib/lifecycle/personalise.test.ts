import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { suppressEmailCategory } from "@/lib/email/suppression";
import type { ProductContext } from "@/lib/connect/protocol";
import type { AiDraft } from "@/lib/types/lifecycle";
import { enrolUser, enrolmentDocId } from "./enrol";
import { processEnrolment, runEnrolmentNow } from "./runner";
import { prepareDueDrafts } from "./prepare";
import { countWaitingApprovals, decideApproval, listApprovals, type ApprovalView } from "./approvals";
import { AI_LINE_MARKER, draftDocId } from "./drafts";
import { STEPS, T0, contextStub, ctx, productContext, publishOnboarding, seedUser, seedWorld, sendStub, system } from "./testing/fixtures";

const MIN = 60_000;
const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const LINE = "That's a strong start — the prompts you monitor next will show where to focus.";

beforeEach(() => {
  process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
  process.env.LIFECYCLE_MODE_CEILING = "live";
  process.env.LIFECYCLE_AI_DRAFTS_ENABLED = "true";
});
afterEach(() => {
  delete process.env.EMAIL_LINK_ORIGIN;
  delete process.env.LIFECYCLE_MODE_CEILING;
  delete process.env.LIFECYCLE_AI_DRAFTS_ENABLED;
});

async function world(opts: { source?: "trigger" | "backfill" } = {}) {
  const db = new FakeFirestore();
  seedWorld(db);
  const user = seedUser(db, "alex");
  const { journey, version } = await publishOnboarding(db, { mode: "test", testUserIds: ["alex"] });
  await enrolUser(system, { journey, version, user, source: opts.source ?? "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 });
  const enrolmentId = enrolmentDocId(journey.id, user.id);

  let now = T0;
  let context: ProductContext | null = productContext();
  let onFetch: (() => void) | null = null;
  const ctxStub = contextStub(() => {
    onFetch?.();
    return context;
  });
  const sends = sendStub();
  const prompts: string[] = [];
  let answer: string | null = JSON.stringify({ line: LINE, subject: "" });
  const generate = async (prompt: string) => {
    prompts.push(prompt);
    return answer;
  };
  const deps = { db, now: () => now, send: sends.send, fetchContext: ctxStub.fetchContext, generate };
  const drafts = () => forTenant(system, db).lifecycleDrafts.find();
  const draft = async (itemId = "r1", poolId = "reminders") =>
    (await forTenant(system, db).lifecycleDrafts.getById(draftDocId(enrolmentId, poolId, itemId)))!;
  const enrolment = async () => (await forTenant(system, db).lifecycleEnrolments.getById(enrolmentId))!;
  return {
    db,
    journey,
    user,
    enrolmentId,
    sent: sends.sent,
    prompts,
    deps,
    drafts,
    draft,
    enrolment,
    setContext: (c: ProductContext | null) => (context = c),
    setAnswer: (a: string | null) => (answer = a),
    onFetch: (f: (() => void) | null) => (onFetch = f),
    run: (at: number) => {
      now = at;
      return processEnrolment(system, enrolmentId, deps);
    },
    prepare: (at: number, extra: { draftsPerDay?: number } = {}) => {
      now = at;
      return prepareDueDrafts(system, { ...deps, ...extra });
    },
  };
}

/** Welcome sent; the slot-1 reminder (R1, an AI-line email) booked. Returns its send time. */
async function booked(w: Awaited<ReturnType<typeof world>>): Promise<number> {
  await w.run(T0);
  expect(await w.run(T0 + 15 * MIN)).toBe("sent");
  return Date.parse((await w.enrolment()).nextRunAt!);
}

describe("AI lines: booking, preparing, approving, sending", () => {
  it("books a draft for the predicted AI-line email, 12 h before it sends", async () => {
    const w = await world();
    const sendAt = await booked(w);
    const d = await w.draft();
    expect(d).toMatchObject({
      status: "pending",
      itemId: "r1",
      sendAt: iso(sendAt),
      prepareAt: iso(sendAt - 12 * HOUR),
      approvalDeadline: iso(sendAt - 15 * MIN),
    });
  });

  it("prepares the line from the product's insight — with no personal data in the prompt", async () => {
    const w = await world();
    const sendAt = await booked(w);
    expect(await w.prepare(sendAt - 12 * HOUR)).toEqual({ prepared: 1, fallback: 0, superseded: 0 });
    const d = await w.draft();
    expect(d).toMatchObject({ status: "awaiting_approval", aiLine: LINE, insightId: "i_sov", validationIssues: [] });
    expect(d.allowedTerms).toEqual(expect.arrayContaining(["Sandbox", "ChatGPT", "Share of voice"]));
    expect(d.previewHtml).toContain(AI_LINE_MARKER);
    expect(w.prompts).toHaveLength(1);
    expect(w.prompts[0]).toContain("ChatGPT mentioned you in 3 of 10 answers.");
    expect(w.prompts[0]).not.toContain("alex@customer.test");
    expect(w.prompts[0]).not.toMatch(/\bAlex\b/);
    expect(await countWaitingApprovals(system, w.db, sendAt - 12 * HOUR)).toBe(1);
    expect(await countWaitingApprovals(system, w.db, sendAt)).toBe(0); // the window has closed
  });

  it("an approved line goes out in the email, and the draft is consumed", async () => {
    const w = await world();
    const sendAt = await booked(w);
    await w.prepare(sendAt - 12 * HOUR);
    const listed = await listApprovals(ctx, { view: "waiting" }, w.db, sendAt - 11 * HOUR);
    const [card] = (listed.body as { drafts: ApprovalView[] }).drafts;
    expect(card).toMatchObject({ itemLabel: "R1 · Next step", user: { email: "alex@customer.test" }, closed: false });
    expect(card!.previewHtml).toContain("strong start");
    const r = await decideApproval(ctx, card!.id, { action: "approve", draftVersion: card!.draftVersion }, w.db, sendAt - 11 * HOUR);
    expect(r.status).toBe(200);

    expect(await w.run(sendAt)).toBe("sent");
    const m = w.sent[1]!;
    expect(m.subject).toBe("Your next step: Add your brand");
    expect(m.html).toContain("ChatGPT mentioned you in 3 of 10 answers. That&#39;s a strong start");
    const e = await w.enrolment();
    expect(e.sentItems[1]).toMatchObject({ itemId: "r1", status: "sent", version: "ai" });
    expect(e.usedInsightIds).toEqual(["i_sov"]);
    expect(await w.draft()).toMatchObject({ status: "used", usedVersion: "ai" });
  });

  it("Run now prepares a waiting draft first, then sends the approved line", async () => {
    const w = await world();
    const sendAt = await booked(w);
    const early = sendAt - 30 * HOUR; // long before its usual prepare time
    expect(await runEnrolmentNow(ctx, w.enrolmentId, { ...w.deps, now: () => early })).toEqual({ ok: true, outcome: "draft_prepared" });
    const d = await w.draft();
    expect(d).toMatchObject({ status: "awaiting_approval", aiLine: LINE });
    expect(w.sent).toHaveLength(1); // nothing sent by the first press

    expect((await decideApproval(ctx, d.id, { action: "approve", draftVersion: d.draftVersion }, w.db, early)).status).toBe(200);
    expect(await runEnrolmentNow(ctx, w.enrolmentId, { ...w.deps, now: () => early })).toEqual({ ok: true, outcome: "sent" });
    expect(w.sent[1]!.html).toContain("strong start");
    expect((await w.enrolment()).sentItems[1]).toMatchObject({ itemId: "r1", version: "ai" });
  });

  it("without a decision the standard version sends (no_decision)", async () => {
    const w = await world();
    const sendAt = await booked(w);
    await w.prepare(sendAt - 12 * HOUR);
    await w.run(sendAt);
    expect(w.sent[1]!.html).not.toContain("strong start");
    expect((await w.enrolment()).sentItems[1]).toMatchObject({ itemId: "r1", version: "fallback", reason: "no_decision" });
    expect(await w.draft()).toMatchObject({ status: "used", usedVersion: "fallback", fallbackReason: "no_decision" });
  });

  it("falls back if the insight disappeared from the product by send time", async () => {
    const w = await world();
    const sendAt = await booked(w);
    await w.prepare(sendAt - 12 * HOUR);
    const d = await w.draft();
    expect(await decideApproval(ctx, d.id, { action: "approve", draftVersion: d.draftVersion }, w.db, sendAt - 11 * HOUR)).toMatchObject({ status: 200 });
    w.setContext(productContext({ insights: [] }));
    await w.run(sendAt);
    expect((await w.enrolment()).sentItems[1]).toMatchObject({ version: "fallback", reason: "insight_stale" });
  });

  it("staff can skip an email: it never goes out, and the journey carries on", async () => {
    const w = await world();
    const sendAt = await booked(w);
    await w.prepare(sendAt - 12 * HOUR);
    const d = await w.draft();
    expect(await decideApproval(ctx, d.id, { action: "skip", draftVersion: d.draftVersion }, w.db, sendAt - HOUR)).toMatchObject({ status: 200 });
    expect(await w.run(sendAt)).toBe("waiting");
    expect(w.sent).toHaveLength(1);
    const e = await w.enrolment();
    expect(e.sentItems[1]).toMatchObject({ itemId: "r1", status: "skipped", reason: "staff_skipped" });
    expect(e.cursor).toEqual({ nodeId: "cond_2" });
    // Slot 2's reminder is the NEXT one (R2): R1 is never offered again.
    expect((await w.drafts()).map((x) => x.itemId).sort()).toEqual(["r1", "r2"]);
  });

  it("rejects an edit that invents a number (422), a stale version and a late decision (409)", async () => {
    const w = await world();
    const sendAt = await booked(w);
    await w.prepare(sendAt - 12 * HOUR);
    const d = await w.draft();
    const bad = await decideApproval(ctx, d.id, { action: "approve", draftVersion: d.draftVersion, aiLine: "You're 40% ahead of rivals." }, w.db, sendAt - HOUR);
    expect(bad).toMatchObject({ status: 422, body: { error: "invalid_line" } });
    expect(await decideApproval(ctx, d.id, { action: "approve", draftVersion: d.draftVersion - 1 }, w.db, sendAt - HOUR)).toMatchObject({
      status: 409,
      body: { error: "stale" },
    });
    expect(await decideApproval(ctx, d.id, { action: "approve", draftVersion: d.draftVersion }, w.db, sendAt - 10 * MIN)).toMatchObject({
      status: 409,
      body: { error: "closed" },
    });
    // An attested name makes an otherwise-unknown name acceptable.
    const attested = await decideApproval(
      ctx,
      d.id,
      { action: "approve", draftVersion: d.draftVersion, aiLine: "Perplexity is worth a look next.", attestedTerms: ["Perplexity"] },
      w.db,
      sendAt - HOUR,
    );
    expect(attested).toMatchObject({ status: 200, body: { draft: { status: "approved", aiLine: "Perplexity is worth a look next." } } });
  });

  it("a model failure or an invalid line lands on the standard version", async () => {
    const w = await world();
    const sendAt = await booked(w);
    w.setAnswer(null);
    expect(await w.prepare(sendAt - 12 * HOUR)).toMatchObject({ fallback: 1 });
    expect(await w.draft()).toMatchObject({ status: "use_fallback", fallbackReason: "generation_failed" });

    const v = await world();
    const at = await booked(v);
    v.setAnswer(JSON.stringify({ line: "You're 3x ahead of Perplexity already.", subject: "" }));
    await v.prepare(at - 12 * HOUR);
    const d = await v.draft();
    expect(d).toMatchObject({ status: "use_fallback", fallbackReason: "validation_failed" });
    expect(d.validationIssues.length).toBeGreaterThan(0);
    await v.run(at);
    expect((await v.enrolment()).sentItems[1]).toMatchObject({ version: "fallback", reason: "validation_failed" });
  });

  it("re-predicts at prepare time: finishing onboarding overnight swaps the reminder for education", async () => {
    const w = await world();
    const sendAt = await booked(w);
    w.setContext(productContext({ done: STEPS.map((s) => s.id) }));
    expect(await w.prepare(sendAt - 12 * HOUR)).toMatchObject({ superseded: 1 });
    expect(await w.draft()).toMatchObject({ status: "superseded" });
    const e1 = await w.draft("e1", "education");
    expect(e1).toMatchObject({ status: "pending", sendAt: iso(sendAt) });
    expect(await w.prepare(sendAt - 12 * HOUR + MIN)).toMatchObject({ prepared: 1 });
  });

  it("respects the daily AI-draft cap", async () => {
    const w = await world();
    const sendAt = await booked(w);
    expect(await w.prepare(sendAt - 12 * HOUR, { draftsPerDay: 0 })).toMatchObject({ fallback: 1 });
    expect(await w.draft()).toMatchObject({ status: "use_fallback", fallbackReason: "draft_cap" });
    expect(w.prompts).toHaveLength(0);
  });

  it("backfilled people are skipped unless staff approved", async () => {
    const w = await world({ source: "backfill" });
    const sendAt = await booked(w);
    await w.prepare(sendAt - 12 * HOUR);
    expect(await w.run(sendAt)).toBe("waiting");
    expect(w.sent).toHaveLength(1); // the welcome (a service email) still went out
    expect((await w.enrolment()).sentItems[1]).toMatchObject({ itemId: "r1", status: "skipped", reason: "approval_required" });
  });

  it("a decision racing the send can't slip in: the send transaction sees it", async () => {
    const w = await world();
    const sendAt = await booked(w);
    await w.prepare(sendAt - 12 * HOUR);
    let d = await w.draft();
    await decideApproval(ctx, d.id, { action: "approve", draftVersion: d.draftVersion }, w.db, sendAt - HOUR);
    d = await w.draft();
    // Staff edit the line at the very moment the runner sends.
    w.onFetch(() => {
      w.onFetch(null);
      w.db.onBeforeCommit = async () => {
        await forTenant(system, w.db).lifecycleDrafts.update(d.id, { aiLine: "Edited at the last second.", draftVersion: d.draftVersion + 1 });
      };
    });
    await w.run(sendAt);
    expect(w.sent[1]!.html).not.toContain("Edited at the last second");
    expect((await w.enrolment()).sentItems[1]).toMatchObject({ version: "fallback", reason: "changed_during_send" });
  });

  it("leaving the journey retires open drafts", async () => {
    const w = await world();
    const sendAt = await booked(w);
    await w.prepare(sendAt - 12 * HOUR);
    await suppressEmailCategory(system, { email: "alex@customer.test", category: "onboarding", source: "test" }, w.db);
    expect(await w.run(sendAt)).toBe("exited");
    expect(await w.draft()).toMatchObject({ status: "superseded" });
    expect(await countWaitingApprovals(system, w.db, sendAt - 12 * HOUR)).toBe(0);
  });
});

describe("approvals list", () => {
  it("shows decided drafts separately, newest first", async () => {
    const w = await world();
    const sendAt = await booked(w);
    await w.prepare(sendAt - 12 * HOUR);
    const d: AiDraft = await w.draft();
    await decideApproval(ctx, d.id, { action: "fallback", draftVersion: d.draftVersion }, w.db, sendAt - HOUR);
    const waiting = await listApprovals(ctx, { view: "waiting" }, w.db, sendAt - HOUR);
    const decided = await listApprovals(ctx, { view: "decided" }, w.db, sendAt - HOUR);
    expect((waiting.body as { drafts: unknown[] }).drafts).toHaveLength(0);
    expect((decided.body as { drafts: ApprovalView[] }).drafts[0]).toMatchObject({ status: "use_fallback", fallbackReason: "staff_choice", decidedBy: "jez@sandbox.test" });
  });
});
