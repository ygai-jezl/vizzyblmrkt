import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/lib/tenant/types";

// At the month's web search cap, a buying situations step answers before it takes a step of the run.
const meter = vi.hoisted(() => ({ check: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/plans/meter", () => ({ usageMeter: () => meter }));
const runs = vi.hoisted(() => ({ takeStep: vi.fn(), startRun: vi.fn() }));
vi.mock("@/lib/brandMap/runs", async (orig) => ({ ...(await orig<typeof import("@/lib/brandMap/runs")>()), ...runs }));

const { findSituationsFromRequest, situationQuestionsFromRequest } = await import("./situationsApi");

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  meter.check.mockResolvedValue({ limited: true, used: 300, limit: 300 });
});

describe("buying situations at the month's web search cap", () => {
  it("finding situations answers 429 and uses no step of the run", async () => {
    const res = await findSituationsFromRequest(ctx, { runId: "run_1" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "search_limit" });
    expect(runs.takeStep).not.toHaveBeenCalled();
  });

  it("asking a situation's questions answers 429 and uses no step of the run", async () => {
    const res = await situationQuestionsFromRequest(ctx, "sit_1", { runId: "run_1" });
    expect(res.status).toBe(429);
    expect(runs.takeStep).not.toHaveBeenCalled();
  });
});
