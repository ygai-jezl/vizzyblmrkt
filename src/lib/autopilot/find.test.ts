import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { DataForSeoFetch } from "@/lib/signals/dataforseo";
import { envelope, SERP_RESULT } from "@/lib/signals/testing/serpFixture";
import type { SearchOutcome } from "@/lib/search/query";
import { advanceRun, type AdvanceDeps } from "./advance";
import { moveItem, readRunApi, startFind, suggestOthers } from "./adminApi";
import { listLearned } from "./learned";
import { claimRun, createRun, finishStep, getRun, RUN_LEASE_MS } from "./runs";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const B: TenantContext = { ...A, tenantId: "ten_B" };
const ENV = { DATAFORSEO_USERNAME: "api-user@example.com", DATAFORSEO_PASSWORD: "not-a-real-password" };
const Q = { questionId: "q_aaaaaaa1", question: "How do I get cited by AI answers?", subjectId: "sub_aaaaaaaa", subjectName: "Getting cited" };
const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const own: SearchOutcome = { ok: true, result: { hits: [{ sourceKey: "post:p", kind: "post", ref: "p", title: "Our LinkedIn post", url: "/x", snippet: "", matched: "both", score: 1 }], reranked: false, meaning: true } };

function setup() {
  const clock = { t: Date.parse("2026-11-18T12:00:00.000Z") };
  const deps: AdvanceDeps & { db: FakeFirestore; rateLimited: () => Promise<boolean>; canUse: () => Promise<boolean> } = {
    db: new FakeFirestore(),
    now: () => new Date(clock.t),
    env: ENV,
    fetch: vi.fn<DataForSeoFetch>(async (url) =>
      String(url).includes("task_post")
        ? answer(envelope({ id: "aaaaaaaa-0001", status_code: 20100, cost: 0.0012 }))
        : answer(envelope({ id: "aaaaaaaa-0001", status_code: 20000, cost: 0, result: [SERP_RESULT] })),
    ),
    loadTenant: async () => ({ id: "ten_A", grantedFeatures: ["next_up"], allowedOrigins: [] }) as never,
    ownHosts: ["brand.example.com"],
    search: async () => own,
    subjectsNear: async () => ["Getting cited", "Measuring AI visibility"],
    judge: vi.fn(async (_ctx, ask) =>
      ask.items.map((it: { text: string; kind: "paa" | "also" | "theirs" }, i: number) => ({
        ...it,
        verdict: i === 0 ? ("use" as const) : i === 1 ? ("other" as const) : ("drop" as const),
        reason: i === 0 ? "the article's own topic" : "off topic",
        ...(i === 1 ? { subject: "Measuring AI visibility" } : {}),
      })),
    ),
    rateLimited: async () => false,
    canUse: async () => true,
  };
  return { deps, clock };
}

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
  vi.stubEnv("BRAND_SIGNALS_ENABLED", "true");
  vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("a run's lease", () => {
  it("lets one step run at a time, and never lets a late step write over a newer one", async () => {
    const { deps, clock } = setup();
    const run = await createRun(A, { id: "run_aaaaaaaaaaaaaaaaaaaaaaaa", mode: "find", trigger: "person", step: "find", question: { questionId: Q.questionId, text: Q.question, subjectId: Q.subjectId, subjectName: Q.subjectName } }, deps);
    const first = await claimRun(A, run.id, deps);
    expect(first).not.toBeNull();
    expect(await claimRun(A, run.id, deps)).toBeNull();
    clock.t += RUN_LEASE_MS + 1;
    const second = await claimRun(A, run.id, deps);
    expect(await finishStep(A, first!, { step: "sort" }, deps)).toBeNull();
    expect(await finishStep(A, second!, { step: "sort" }, deps)).toMatchObject({ step: "sort", attempts: 0, leaseId: null });
    expect(await getRun(B, run.id, deps)).toBeNull();
  });
});

describe("finding and sorting", () => {
  it("asks Google, waits, then sorts into three trays with the brand's closest page", async () => {
    const { deps, clock } = setup();
    const started = await startFind(A, Q, deps);
    expect(started).toMatchObject({ status: 200, body: { run: { step: "waiting" } } });
    const id = (started.body as { run: { id: string } }).run.id;
    clock.t += 20_000;
    const read = await readRunApi(A, id, deps);
    expect(read).toMatchObject({ status: 200, body: { run: { step: "sort" } } });
    const sorted = await readRunApi(A, id, deps);
    const trays = (sorted.body as { run: { step: string; trays: { use: Array<{ text: string; you: string | null }>; other: Array<{ subject: string }>; drop: unknown[] } } }).run;
    expect(trays.step).toBe("sorted");
    expect(trays.trays.use).toEqual([expect.objectContaining({ text: "How does ChatGPT choose which sources to cite?", you: "Our LinkedIn post" })]);
    expect(trays.trays.other[0]!.subject).toBe("Measuring AI visibility");
    expect(trays.trays.drop.length).toBeGreaterThan(0);
  });

  it("sorts without Google when the brand can't look it up, and says why", async () => {
    const { deps } = setup();
    deps.env = {};
    const started = await startFind(A, Q, deps);
    expect(started).toMatchObject({ body: { run: { step: "sort", googleSkipped: "not_set_up" } } });
  });

  it("tries sorting again when the judge doesn't answer, and fails after its tries", async () => {
    const { deps, clock } = setup();
    deps.env = {};
    deps.judge = vi.fn(async () => null);
    const started = await startFind(A, Q, deps);
    const id = (started.body as { run: { id: string } }).run.id;
    for (let i = 0; i < 3; i += 1) {
      clock.t += 3 * 60_000;
      await advanceRun(A, id, { deadlineMs: Date.now() + 60_000 }, deps);
    }
    expect(await getRun(A, id, deps)).toMatchObject({ step: "failed", error: "judge_failed", active: false });
  });
});

describe("moving and filing", () => {
  async function sortedRun() {
    const { deps } = setup();
    deps.env = {};
    // Competitors' questions only (no Google): two of them.
    deps.judge = vi.fn(async () => [
      { text: "Which pages do AI answers cite?", kind: "theirs" as const, verdict: "use" as const, reason: "fits" },
      { text: "How is AI visibility measured?", kind: "theirs" as const, verdict: "other" as const, reason: "another article", subject: "new: Measuring AI visibility" },
    ]);
    const started = await startFind(A, Q, deps);
    const id = (started.body as { run: { id: string } }).run.id;
    await readRunApi(A, id, deps);
    return { deps, id };
  }

  it("moves an item between trays and keeps it on the Learned list", async () => {
    const { deps, id } = await sortedRun();
    const r = await moveItem(A, id, { text: "Which pages do AI answers cite?", to: "drop" }, deps);
    expect((r.body as { run: { trays: { drop: Array<{ text: string }> } } }).run.trays.drop.map((i) => i.text)).toContain("Which pages do AI answers cite?");
    expect((await listLearned(A, deps))[0]).toMatchObject({ kind: "moved", text: "Which pages do AI answers cite?" });
    expect(await moveItem(B, id, { text: "x", to: "use" }, deps)).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("lets admins file only this run's Another subject items for the brand map", async () => {
    const { deps, id } = await sortedRun();
    expect(await suggestOthers({ ...A, role: "member" }, id, { texts: ["How is AI visibility measured?"] }, deps)).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(await suggestOthers(A, id, { texts: ["Something made up"] }, deps)).toEqual({ status: 400, body: { error: "invalid_input" } });
  });
});
