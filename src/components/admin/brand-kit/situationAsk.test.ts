import { describe, expect, it } from "vitest";
import type { ApiResponse } from "@/components/admin/connect/api";
import type { PlacedQuestion } from "@/lib/brandMap/situationQuestions";
import type { SituationQuestion } from "@/lib/brandMap/situations";
import { askedText, askSituation, proposedOf, type AskRun } from "./situationAsk";

const NOW = Date.parse("2026-10-19T20:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

/** A fake api: answers each call from a list, and keeps what was called. */
function fakeApi(answers: Array<ApiResponse<Record<string, unknown>>>) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const api = async <T,>(path: string, init?: RequestInit): Promise<ApiResponse<T>> => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected call to ${path}`);
    return next as ApiResponse<T>;
  };
  return { api, calls };
}

const started = (id: string, minutes = 30) => ({ ok: true, status: 200, data: { ok: true, run: { id, kind: "situations", stepsLeft: 26, expiresAt: at(minutes) } } });
const asked = (questions: unknown[]) => ({ ok: true, status: 200, data: { ok: true, questions, stepsLeft: 25 } });
const refused = (status: number, error: string) => ({ ok: false, status, data: { error } });
const q = (over: Partial<PlacedQuestion>): PlacedQuestion => ({
  id: "q1",
  text: "How do I find the prompts my buyers use?",
  intent: "how_to",
  status: "proposed",
  subjectId: "sub1",
  subjectName: "Prompt research",
  newSubject: false,
  linked: false,
  ...over,
});

describe("finding what people in one buying situation ask", () => {
  it("starts a run when the page has none, and asks with it", async () => {
    const { api, calls } = fakeApi([started("run_1"), asked([q({})])]);
    const r = await askSituation("sit_1", null, { api, nowMs: NOW });
    expect(r).toMatchObject({ ok: true, run: { id: "run_1" }, questions: [{ id: "q1" }] });
    expect(calls).toEqual([
      { path: "/api/admin/brand-kit/map/runs", body: { kind: "situations" } },
      { path: "/api/admin/brand-kit/map/situations/sit_1/questions", body: { runId: "run_1" } },
    ]);
  });

  it("reuses the page's run while it lasts, so a second situation costs no allowance", async () => {
    const kept: AskRun = { id: "run_1", expiresAt: at(20) };
    const { api, calls } = fakeApi([asked([])]);
    expect(await askSituation("sit_2", kept, { api, nowMs: NOW })).toMatchObject({ ok: true, run: kept });
    expect(calls.map((c) => c.path)).toEqual(["/api/admin/brand-kit/map/situations/sit_2/questions"]);
  });

  it("starts a new run, once, when the kept one has ended, gone or run out of steps", async () => {
    for (const error of ["run_expired", "run_used_up", "no_run"]) {
      const { api, calls } = fakeApi([refused(error === "no_run" ? 404 : 429, error), started("run_2"), asked([])]);
      expect(await askSituation("sit_1", { id: "run_1", expiresAt: at(20) }, { api, nowMs: NOW })).toMatchObject({ ok: true, run: { id: "run_2" } });
      expect(calls.map((c) => c.body)).toEqual([{ runId: "run_1" }, { kind: "situations" }, { runId: "run_2" }]);
    }
    // A kept run about to end isn't used at all.
    const { api, calls } = fakeApi([started("run_3"), asked([])]);
    await askSituation("sit_1", { id: "run_1", expiresAt: new Date(NOW + 5_000).toISOString() }, { api, nowMs: NOW });
    expect(calls.map((c) => c.body)).toEqual([{ kind: "situations" }, { runId: "run_3" }]);
  });

  it("gives back what refused it, and keeps the run unless it has ended", async () => {
    const limited = fakeApi([refused(429, "rate_limited")]);
    expect(await askSituation("sit_1", null, { api: limited.api, nowMs: NOW })).toEqual({ ok: false, status: 429, data: { error: "rate_limited" }, run: null });

    const failed = fakeApi([started("run_1"), refused(502, "research_failed")]);
    expect(await askSituation("sit_1", null, { api: failed.api, nowMs: NOW })).toMatchObject({ ok: false, status: 502, run: { id: "run_1" } });

    // A fresh run refused as ended isn't started a third time.
    const ended = fakeApi([started("run_1"), refused(410, "run_expired")]);
    expect(await askSituation("sit_1", null, { api: ended.api, nowMs: NOW })).toMatchObject({ ok: false, status: 410, run: null });
    expect(ended.calls).toHaveLength(2);
  });
});

describe("what an ask came back with", () => {
  it("counts new questions and ones the map had, now linked", () => {
    expect(askedText([q({ id: "a" }), q({ id: "b" }), q({ id: "c", status: "decided", linked: true })])).toBe(
      "2 new questions to add or dismiss below, and 1 question you already had, now linked to it.",
    );
    expect(askedText([q({})])).toBe("1 new question to add or dismiss below.");
    expect(askedText([q({ status: "decided", linked: true })])).toBe("1 question you already had, now linked to it.");
    expect(askedText([])).toBe("Research found nothing new for it this time.");
  });
});

describe("a situation's proposed questions", () => {
  it("splits those on a subject on the map from those on a new subject, leaving decided ones out", () => {
    const sq = (id: string, status: "proposed" | "decided", newSubject: boolean): SituationQuestion => ({
      id,
      text: id,
      intent: "other",
      status,
      subjectId: "s",
      subjectName: "S",
      newSubject,
      state: "open",
    });
    expect(proposedOf([sq("a", "decided", false), sq("b", "proposed", false), sq("c", "proposed", true), sq("d", "proposed", false)])).toEqual({ onMap: ["b", "d"], onNew: ["c"] });
  });
});
