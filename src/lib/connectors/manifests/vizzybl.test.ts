import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, type TenantContext } from "@/lib/tenant";
import { MEANINGS } from "@/lib/metrics/meanings";
import { nextUpDocId } from "@/lib/types/autopilot";
import { readByUse } from "../byUse";
import { EMPTY_CURSOR } from "../collect/schedule";
import type { ConnectorActor } from "../grants";
import { readLive } from "../live";
import { collectedStream, mcpMethod, parseManifest, MCP_HOOKS } from "../manifest";
import { mcpCollect, mcpVerify } from "../mcp/hooks";
import { getConnector, listConnectors, readyMethods } from "../registry";
import { check, connect, disconnect, readLiveFor, setGrants } from "../service";
import { readAiAnswers } from "../signals/aiAnswers";
import { AI_ANSWERS_CHIP } from "../signals/aiAnswersPicks";
import { fakeMcpServer, toolCalls } from "../testing/mcpServer";
import { PLANNING } from "../testing/signals";
import { vizzyblManifest } from "./vizzybl";

/**
 * Vizzybl, the first data only connector (ADR-0019), against a made-up MCP server that answers the
 * way Vizzybl's does: each tool's text is the JSON of the public API's data, a list with its
 * pagination. Nothing reaches Vizzybl; every brand, prompt, page and number is invented.
 */

const A: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const admin: ConnectorActor = { kind: "human", uid: "usr_admin", role: "admin" };
const KEY = "vzbl_live_madeupkey0000000000";
const ID = "dcn_vvvvvvvvvvvvvvvvvvvv";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const manifest = parseManifest(vizzyblManifest);

/** Answers shaped like Vizzybl's tools: data, and a list's pagination. */
const TOOLS = {
  get_brand: () => ({ brandName: "Acme", primaryDomain: "acme.example", brandVariants: ["acme"], competitors: ["rival.example"] }),
  get_visibility_history: (args: Record<string, unknown>) => ({
    data: [
      { date: "2026-11-20", shareOfVoice: 31.4, mentions: 142, rank: 2, sentimentScore: 18, competitors: [], totalCompetitors: 5 },
      { date: "2026-11-19", shareOfVoice: 29.9, mentions: 130, rank: null, sentimentScore: null, competitors: [], totalCompetitors: 5 },
    ].filter((d) => d.date >= String(args.startDate) && d.date <= String(args.endDate)),
    pagination: { nextCursor: null, hasMore: false, limit: args.limit },
  }),
  list_prompts: () => ({
    data: [
      {
        promptId: "p_1",
        text: "best geo tools for agencies",
        status: "active",
        metrics: { totalBrandMentions: 0, totalCitations: 30, competitorCount: 4, brandSentimentScore: null, platformsScraped: ["chatgpt", "claude", "gemini", "perplexity", "grok", "copilot"] },
      },
    ],
    pagination: { nextCursor: "c2", hasMore: true, limit: 100 },
  }),
  find_prompts_citing: () => ({ data: [{ promptId: "p_1", prompt: "best geo tools for agencies", engines: ["chatgpt", "perplexity"], citationCount: 4 }], pagination: { nextCursor: null, hasMore: false, limit: 100 } }),
  get_citation_stats: () => ({
    domainRank: [{ domain: "acme.example", count: 42, citationShare: 0.42, main: true }],
    mostCitedUrls: [
      { url: "https://acme.example/pricing?utm=x", domain: "acme.example", count: 18, citationShare: 0.3, sourceType: "corporate" },
      { url: "https://reviews.example/best-geo", domain: "reviews.example", count: 12, citationShare: 0.2, sourceType: "editorial" },
    ],
    totals: { totalCitations: 60 },
  }),
};

const health = { state: "ok" as const, lastOkAt: null, lastCheckedAt: null, lastErrorCode: null, failures: 0, pausedUntil: null };
const input = { manifest, connection: { id: ID, tenantId: "ten_a", pausedAt: null, health }, account: "acme.example", token: KEY };

describe("the Vizzybl manifest", () => {
  it("is data only: the MCP method, the engine's hooks, its server's host in api", () => {
    const method = mcpMethod(manifest)!;
    expect(method.url).toBe("https://mcp.vizzybl.ai/v1/mcp");
    expect(manifest.api.hosts).toEqual([new URL(method.url).hostname]);
    expect(manifest.verify).toEqual({ method: "POST", url: method.url, hook: MCP_HOOKS.verify });
    expect(manifest.hooks).toEqual({ live: MCP_HOOKS.live, collect: MCP_HOOKS.collect });
    expect(method.verify.tool).toBe("get_brand");
    expect(manifest.uses).toEqual(["vizzy.read", "signals.ai_answers"]);
  });

  it("gives every number a meaning, and collects only the daily share of voice", () => {
    for (const p of manifest.produces) for (const k of p.measures) expect(Object.keys(MEANINGS), `${p.stream}: ${k}`).toContain(k);
    expect(collectedStream(manifest)?.stream).toBe("ai_visibility");
    expect(manifest.produces.map((p) => [p.stream, p.mcp!.tool])).toEqual([
      ["ai_visibility", "get_visibility_history"],
      ["monitored_prompts", "list_prompts"],
      ["prompts_citing_page", "find_prompts_citing"],
      ["cited_pages", "get_citation_stats"],
    ]);
  });

  it("only reads: no tool that spends credits or writes, and read scopes only", () => {
    const tools = [mcpMethod(manifest)!.verify.tool, ...manifest.produces.map((p) => p.mcp!.tool)];
    for (const spends of ["run_audit", "create_prompts", "scrape_prompt", "get_audit"]) expect(tools).not.toContain(spends);
    for (const scope of mcpMethod(manifest)!.permissions) expect(scope).toMatch(/^read:/);
    expect(manifest.shares.filter((s) => s.direction === "never").map((s) => s.what)).toEqual(["Audits and prompt scrapes", "Anything else"]);
    expect(JSON.stringify(manifest.shares)).toContain("spends none of your Vizzybl credits");
  });

  it("takes only a Vizzybl key", () => {
    const pattern = new RegExp(mcpMethod(manifest)!.auth.field.pattern);
    expect(pattern.test(KEY)).toBe(true);
    expect(pattern.test("sk-madeup-0000000000000000")).toBe(false);
  });
});

describe("the switches", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lists Vizzybl only with the core, the MCP method and its own switch, each exactly true", () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTOR_VIZZYBL_ENABLED", "true");
    expect(getConnector("vizzybl")).toBeNull();
    vi.stubEnv("CONNECTOR_MCP_ENABLED", "yes");
    expect(getConnector("vizzybl")).toBeNull();
    vi.stubEnv("CONNECTOR_MCP_ENABLED", "true");
    expect(getConnector("vizzybl")?.name).toBe("Vizzybl");
    expect(readyMethods(manifest)).toEqual(["mcp"]);
    vi.stubEnv("CONNECTOR_VIZZYBL_ENABLED", "false");
    expect(listConnectors().map((m) => m.id)).not.toContain("vizzybl");
  });
});

describe("the engine against answers shaped like Vizzybl's", () => {
  const deps = (server: ReturnType<typeof fakeMcpServer>) => ({ transport: server.transport, limit: async () => false, log: () => {}, now: NOW });

  it("verifies with get_brand, naming the brand's domain and name", async () => {
    const server = fakeMcpServer({ tools: TOOLS, sse: true });
    expect(await mcpVerify({ ...input, account: "" }, deps(server))).toEqual({ ok: true, account: "acme.example", label: "Acme" });
    expect(toolCalls(server.requests)).toEqual([{ name: "get_brand", args: {} }]);
  });

  it("reads the daily share of voice by day, oldest first, a rank Vizzybl didn't give left empty", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    const r = await readLive({ ...input, query: { stream: "ai_visibility", period: "last_7_days", by: "day", limit: 100 } }, deps(server));
    expect(toolCalls(server.requests)).toEqual([{ name: "get_visibility_history", args: { startDate: "2026-11-14", endDate: "2026-11-20", limit: 100 } }]);
    expect(r).toMatchObject({
      ok: true,
      answer: {
        rows: [
          { day: "2026-11-19", aiShareOfVoice: 29.9, aiMentions: 130, aiRank: null, aiSentiment: null },
          { day: "2026-11-20", aiShareOfVoice: 31.4, aiMentions: 142, aiRank: 2, aiSentiment: 18 },
        ],
        period: { from: "2026-11-14", to: "2026-11-20", timeZone: "UTC" },
      },
    });
  });

  it("reads the monitored prompts with the engines asked, counted as a number too", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    const r = await readLive({ ...input, query: { stream: "monitored_prompts", period: "last_28_days", by: "topic", limit: 100 } }, deps(server));
    expect(toolCalls(server.requests)).toEqual([{ name: "list_prompts", args: { status: "monitored", limit: 100 } }]);
    expect(r).toMatchObject({
      ok: true,
      answer: {
        more: true,
        rows: [{ prompt: "best geo tools for agencies", engines: "chatgpt, claude, gemini, perplexity, grok, copilot", promptEngines: 6, promptBrandMentions: 0, promptCompetitors: 4, promptCitations: 30 }],
        notes: ["Vizzybl gives these numbers as they stand now, not for the days asked."],
      },
    });
  });

  it("reads the prompts citing one page by its address on the brand's domain", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    const r = await readLive({ ...input, query: { stream: "prompts_citing_page", period: "last_28_days", by: "topic", limit: 50, page: "/pricing" } }, deps(server));
    expect(toolCalls(server.requests)).toEqual([{ name: "find_prompts_citing", args: { url: "https://acme.example/pricing", limit: 50 } }]);
    expect(r).toMatchObject({ ok: true, answer: { rows: [{ prompt: "best geo tools for agencies", engines: "chatgpt, perplexity", aiCitations: 4 }] } });
  });

  it("reads the most cited pages for the days asked, each page as its path beside its domain", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    const r = await readLive({ ...input, query: { stream: "cited_pages", period: "last_28_days", by: "page", limit: 100 } }, deps(server));
    expect(toolCalls(server.requests)).toEqual([{ name: "get_citation_stats", args: { startDate: "2026-10-24", endDate: "2026-11-20" } }]);
    expect(r).toMatchObject({
      ok: true,
      answer: {
        rows: [
          { page: "/pricing", domain: "acme.example", aiCitations: 18, aiCitationShare: 0.3 },
          { page: "/best-geo", domain: "reviews.example", aiCitations: 12, aiCitationShare: 0.2 },
        ],
      },
    });
  });

  it("collects the daily share of voice, a day Vizzybl didn't list kept empty", async () => {
    const server = fakeMcpServer({ tools: TOOLS });
    const r = await mcpCollect({ ...input, ask: { stream: collectedStream(manifest)!, cursor: { ...EMPTY_CURSOR, lastDay: "2026-11-17", finalThrough: "2026-11-17", backfilledTo: "2026-08-20", filled: true, timeZone: "UTC" }, now: NOW, canStart: () => true } }, deps(server));
    expect(r.days.map((d) => [d.day, d.final, d.docs[0]!.totals])).toEqual([
      ["2026-11-18", true, { aiShareOfVoice: null, aiMentions: null, aiRank: null, aiSentiment: null }],
      ["2026-11-19", true, { aiShareOfVoice: 29.9, aiMentions: 130, aiRank: null, aiSentiment: null }],
      ["2026-11-20", true, { aiShareOfVoice: 31.4, aiMentions: 142, aiRank: 2, aiSentiment: 18 }],
    ]);
  });
});

describe("connecting Vizzybl, and what reads it", () => {
  let db: FakeFirestore;
  let server: ReturnType<typeof fakeMcpServer>;
  const deps = () => ({ db, transport: server.transport, limit: async () => false, log: () => {}, newId: () => ID, now: NOW });

  beforeEach(() => {
    db = new FakeFirestore();
    server = fakeMcpServer({ tools: TOOLS, sessionId: "made-up-session" });
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTOR_MCP_ENABLED", "true");
    vi.stubEnv("CONNECTOR_VIZZYBL_ENABLED", "true");
    vi.stubEnv("CONNECTORS_VAULT_KEY", "vizzybl-test-vault-root-0123456789abcdef");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("checks the key with get_brand first, then saves it sealed, as a token connection named for the brand", async () => {
    const r = await connect(A, admin, "vizzybl", { fields: { apiKey: KEY } }, deps());
    expect(r).toMatchObject({ ok: true, status: 201, value: { id: ID, label: "Acme", details: { method: "token_fields", account: "acme.example" } } });
    const raw = db.raw("data_connections", ID)!;
    expect(raw.secrets).toMatchObject({ apiKey: { encKeyId: expect.stringMatching(/^[0-9a-f]{16}$/) } });
    expect(JSON.stringify(raw)).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain(KEY);
    // One brand's Vizzybl is connected once.
    server = fakeMcpServer({ tools: TOOLS });
    expect(await connect(A, admin, "vizzybl", { fields: { apiKey: KEY } }, { ...deps(), newId: () => "dcn_wwwwwwwwwwwwwwwwwwww" })).toMatchObject({ ok: false, status: 409, error: "already_connected" });
  });

  it("saves nothing for a key Vizzybl turns down, or one that isn't a Vizzybl key", async () => {
    server = fakeMcpServer({ tools: TOOLS, status: 401 });
    expect(await connect(A, admin, "vizzybl", { fields: { apiKey: KEY } }, deps())).toMatchObject({ ok: false, error: "token_refused", message: expect.stringContaining("Vizzybl turned the token down, so nothing was saved.") });
    expect(await connect(A, admin, "vizzybl", { fields: { apiKey: "not-a-vizzybl-key-000000" } }, deps())).toMatchObject({ ok: false, status: 400, error: "invalid_fields", message: "Check API key." });
    expect(db.dump("data_connections")).toEqual([]);
  });

  it("opens the sealed key for a live read, and Check now finds a key that now reads another brand", async () => {
    await connect(A, admin, "vizzybl", { fields: { apiKey: KEY } }, deps());
    const r = await readLiveFor(A, admin, ID, { stream: "ai_visibility", period: "last_7_days" }, deps());
    expect(r).toMatchObject({ ok: true, value: { connectorId: "vizzybl", rows: [{ day: "2026-11-19" }, { day: "2026-11-20" }] } });
    expect(server.requests.filter((q) => q.method === "tools/call").every((q) => q.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    server = fakeMcpServer({ tools: { ...TOOLS, get_brand: () => ({ brandName: "Other", primaryDomain: "other.example" }) } });
    expect(await check(A, admin, ID, deps())).toMatchObject({ ok: true, value: { check: { ok: false, code: "account_refused" }, connection: { health: { state: "broken" } } } });
  });

  it("feeds readByUse and Next up only once members and Vizzy may both read it", async () => {
    await connect(A, admin, "vizzybl", { fields: { apiKey: KEY } }, deps());
    const ask = { measures: ["promptEngines", "promptBrandMentions"] as const, by: "topic" as const, period: "last_28_days" as const };
    expect((await readByUse(A, "signals.ai_answers", ask, { ...deps(), job: "next_up" })).reads).toEqual([]);
    await setGrants(A, admin, ID, { grants: PLANNING }, deps());
    const r = await readByUse(A, "signals.ai_answers", ask, { ...deps(), job: "next_up" });
    expect(r.reads).toMatchObject([{ connectorId: "vizzybl", stream: "monitored_prompts", from: "live", rows: [{ keys: { topic: "best geo tools for agencies", engines: "chatgpt, claude, gemini, perplexity, grok, copilot" }, m: { promptEngines: 6, promptBrandMentions: 0 } }] }]);
    // The job's read is logged by the job, off the record's recent list.
    vi.stubEnv("CONNECTOR_AI_ANSWERS_ENABLED", "true");
    expect(await readAiAnswers(A, deps())).toMatchObject({ prompts: [{ text: "best geo tools for agencies", m: { promptEngines: 6, promptBrandMentions: 0, promptCompetitors: 4, promptCitations: 30 } }] });
  });

  it("takes off stored Next up picks that weighed AI answers when it stops feeding planning, or is disconnected", async () => {
    await connect(A, admin, "vizzybl", { fields: { apiKey: KEY } }, deps());
    await setGrants(A, admin, ID, { grants: PLANNING }, deps());
    const pick = (id: string, label: string) => ({ questionId: id, question: id, subjectId: "sub_a", subjectName: "A", because: "6 engines answer it.", chips: [{ kind: "num" as const, label, text: "x" }], from: "gemini" as const });
    const seedPicks = async () => {
      const doc = { picks: [pick("q_a", AI_ANSWERS_CHIP), pick("q_b", "Brand map")], notOnMap: [], missing: [], candidates: 2, at: NOW.toISOString(), by: "person" as const };
      await forTenant(A, db).nextUp.upsert(nextUpDocId(A.tenantId), () => doc, () => doc);
    };
    const picks = async () => (await forTenant(A, db).nextUp.getById(nextUpDocId(A.tenantId)))!.picks.map((p) => p.questionId);
    await seedPicks();
    await setGrants(A, admin, ID, { grants: [{ to: "members", can: "read" }] }, deps());
    expect(await picks()).toEqual(["q_b"]);
    await setGrants(A, admin, ID, { grants: PLANNING }, deps());
    await seedPicks();
    await disconnect(A, admin, ID, deps());
    expect(await picks()).toEqual(["q_b"]);
  });
});
