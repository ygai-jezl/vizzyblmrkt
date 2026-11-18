import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { lookupStatus, readLookup, readMarket, saveMarket, startLookup, type AdminDeps } from "./adminApi";
import type { DataForSeoFetch } from "./dataforseo";
import { FIRST_LOOK_MS } from "./store";
import { envelope, SERP_RESULT } from "./testing/serpFixture";
import { boxLines, mergeIntoBox } from "./view";
import type { BrandSignal, SerpJudgement } from "@/lib/types/brandSignal";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", role: "member" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken", role: "admin" };
const ADMIN: TenantContext = { ...A, role: "admin" };
const ENV = { DATAFORSEO_USERNAME: "api-user@example.com", DATAFORSEO_PASSWORD: "not-a-real-password" };
const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function setup(t: Partial<Tenant> = {}) {
  const clock = { t: Date.parse("2026-11-18T12:00:00.000Z") };
  const fetch = vi.fn<DataForSeoFetch>(async (url) =>
    String(url).includes("task_post")
      ? answer(envelope({ id: "aaaaaaaa-0001", status_code: 20100, cost: 0.0012 }))
      : answer(envelope({ id: "aaaaaaaa-0001", status_code: 20000, cost: 0, result: [SERP_RESULT] })),
  );
  const deps: AdminDeps & { db: FakeFirestore } = {
    db: new FakeFirestore(),
    now: () => new Date(clock.t),
    env: ENV,
    fetch,
    loadTenant: async (id) => ({ id, region: "us", allowedOrigins: [], ...t }) as unknown as Tenant,
    ownHosts: ["brand.example.com"],
    rateLimited: async () => false,
    // The judge keeps the first question, sends the second to another article, drops the rest.
    judge: vi.fn(async (_ctx: TenantContext, sig: BrandSignal): Promise<SerpJudgement> => ({
      at: "2026-11-18T12:00:20.000Z",
      version: 1,
      items: (sig.results?.paa ?? []).map((p, i: number) => ({ text: p.question, kind: "paa" as const, verdict: i === 0 ? "use" : i === 1 ? "other" : "drop", reason: i === 0 ? "the article's own topic" : "off topic" })),
    })),
  };
  return { deps, fetch, clock };
}

beforeEach(() => {
  vi.stubEnv("BRAND_SIGNALS_ENABLED", "true");
  vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("Get from Google", () => {
  it("is unavailable with the switch off", async () => {
    const { deps } = setup();
    vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "false");
    expect(await lookupStatus(A, deps)).toEqual({ status: 503, body: { error: "unavailable" } });
    expect(await startLookup(A, { query: "How?" }, deps)).toEqual({ status: 503, body: { error: "unavailable" } });
    expect(await readLookup(A, "sig_" + "a".repeat(24), deps)).toEqual({ status: 503, body: { error: "unavailable" } });
  });

  it("tells the page the market and this month's use, and hides itself for a brand without next_up", async () => {
    const { deps } = setup({ searchMarket: { country: "GB", language: "en" } });
    expect(await lookupStatus(A, deps)).toEqual({ status: 200, body: { available: true, market: "Google United Kingdom, English", used: 0, limit: 100 } });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "next_up");
    expect(await lookupStatus(A, deps)).toEqual({ status: 403, body: { error: "not_included" } });
    expect(await lookupStatus(A, { ...deps, env: {}, loadTenant: async () => ({ grantedFeatures: ["next_up"] }) as unknown as Tenant })).toMatchObject({
      status: 200,
      body: { available: false },
    });
  });

  it("refuses bad input and too many lookups at once, before asking Google", async () => {
    const { deps, fetch } = setup();
    expect(await startLookup(A, { query: "x" }, deps)).toEqual({ status: 400, body: { error: "invalid_input" } });
    expect(await startLookup(A, { query: "How do I?", questionId: "q_1; drop" }, deps)).toEqual({ status: 400, body: { error: "invalid_input" } });
    expect(await startLookup(A, { query: "How do I get cited?" }, { ...deps, rateLimited: async () => true })).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets a member look a question up, then collects it when the page checks back", async () => {
    const { deps, clock } = setup();
    const started = await startLookup(A, { query: "How do I get cited by AI answers?", questionId: "q_1" }, deps);
    expect(started).toMatchObject({ status: 200, body: { reused: false, signal: { status: "posted", lines: [] } } });
    const id = (started.body as { signal: { id: string } }).signal.id;
    expect(JSON.stringify(started.body)).not.toContain("aaaaaaaa-0001");

    expect(await readLookup(A, id, deps)).toMatchObject({ status: 200, body: { signal: { status: "posted" } } });
    clock.t += FIRST_LOOK_MS;
    const read = await readLookup(A, id, deps);
    expect(read).toMatchObject({ status: 200, body: { signal: { status: "ready", judged: true, numbers: { googlePosition: 3 } } } });
    const view = (read.body as { signal: { lines: string[]; leftOut: Array<{ verdict: string }> } }).signal;
    expect(view.lines).toEqual(["How does ChatGPT choose which sources to cite?"]);
    expect(view.leftOut.map((l) => l.verdict)).toEqual(["other", "drop"]);
    // Judged once: reading it again keeps the stored verdicts.
    await readLookup(A, id, deps);
    expect(deps.judge).toHaveBeenCalledTimes(1);
  });

  it("adds nothing until the judge has checked the results, and tries it again next time", async () => {
    const { deps, clock } = setup();
    deps.judge = vi.fn(async () => null);
    const started = await startLookup(A, { query: "How do I get cited by AI answers?" }, deps);
    const id = (started.body as { signal: { id: string } }).signal.id;
    clock.t += FIRST_LOOK_MS;
    expect(await readLookup(A, id, deps)).toMatchObject({ status: 200, body: { signal: { status: "ready", judged: false, lines: [] } } });
    expect(deps.judge).toHaveBeenCalledTimes(1);
    await readLookup(A, id, deps);
    expect(deps.judge).toHaveBeenCalledTimes(2);
  });

  it("never shows another brand's lookup, and checks the id", async () => {
    const { deps } = setup();
    const started = await startLookup(A, { query: "How do I get cited by AI answers?" }, deps);
    const id = (started.body as { signal: { id: string } }).signal.id;
    expect(await readLookup(B, id, deps)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await readLookup(A, "../ten_B/sig", deps)).toEqual({ status: 400, body: { error: "invalid_input" } });
  });
});

describe("the Google market", () => {
  it("shows the default until chosen, and the choices", async () => {
    const { deps } = setup();
    const r = await readMarket(A, deps);
    expect(r).toMatchObject({ status: 200, body: { market: { country: "US", language: "en" }, chosen: false, label: "Google United States, English" } });
    expect((r.body as { countries: unknown[] }).countries.length).toBeGreaterThan(20);
  });

  it("lets only admins change it, and only to a market we list", async () => {
    const { deps } = setup();
    const save = vi.fn(async () => true);
    expect(await saveMarket(A, { market: { country: "GB", language: "en" } }, { ...deps, save })).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(await saveMarket(ADMIN, { market: { country: "XX", language: "en" } }, { ...deps, save })).toEqual({ status: 400, body: { error: "invalid_input" } });
    expect(await saveMarket(ADMIN, { market: { country: "GB", language: "tlh" } }, { ...deps, save })).toEqual({ status: 400, body: { error: "invalid_input" } });
    expect(save).not.toHaveBeenCalled();
    expect(await saveMarket(ADMIN, { market: { country: "gb", language: "en" } }, { ...deps, save })).toMatchObject({ status: 200, body: { label: "Google United Kingdom, English", chosen: true } });
    expect(save).toHaveBeenCalledWith("ten_A", { country: "GB", language: "en" });
    expect(await saveMarket(ADMIN, { market: null }, { ...deps, save })).toMatchObject({ status: 200, body: { chosen: false } });
    expect(save).toHaveBeenLastCalledWith("ten_A", null);
  });

  it("is unavailable with the signals switch off", async () => {
    vi.stubEnv("BRAND_SIGNALS_ENABLED", "false");
    const { deps } = setup();
    expect(await readMarket(A, deps)).toEqual({ status: 503, body: { error: "unavailable" } });
    expect(await saveMarket(ADMIN, { market: null }, deps)).toEqual({ status: 503, body: { error: "unavailable" } });
  });
});

describe("filling the box", () => {
  it("adds only what the judge kept, questions first, once each, after what someone typed", () => {
    const lines = boxLines([
      { text: "How does it choose?", kind: "paa", verdict: "use", reason: "" },
      { text: "a", kind: "also", verdict: "use", reason: "" },
      { text: "b", kind: "also", verdict: "use", reason: "" },
      { text: "c", kind: "also", verdict: "use", reason: "" },
    ]);
    expect(lines).toEqual(["How does it choose?", "Also searched: a; b; c"]);
    expect(mergeIntoBox("From a sales call: is it safe?\n", lines)).toEqual({ text: `From a sales call: is it safe?\n\n${lines.join("\n")}`, added: 2 });
    expect(mergeIntoBox("how does it choose?", ["How does it choose?"])).toEqual({ text: "how does it choose?", added: 0 });
    expect(mergeIntoBox("", ["One", "Two"])).toEqual({ text: "One\nTwo", added: 2 });
    expect(mergeIntoBox("x".repeat(5995), ["A long line"]).added).toBe(0);
  });
});
