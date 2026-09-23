import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { buildProductMapRunRequest } from "@/lib/knowledge/runJob";
import { createConnection } from "./keys";
import { SANDBOX_CATALOG } from "./sandbox";
import { ANALYSES_PER_DAY, acceptProductMap, listRepoAnalyses, parseRepoUrl, startRepoAnalysis } from "./repoAnalysis";

const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", email: "jez@acme.test", role: "admin" };
const NOW = Date.parse("2026-09-23T10:00:00Z");

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => __resetRateLimitState());

async function world() {
  const db = new FakeFirestore();
  const { connection } = await createConnection(ctx, { name: "Acme", kind: "custom", catalog: SANDBOX_CATALOG }, db);
  const triggered: unknown[] = [];
  const trigger = async (v: unknown) => {
    triggered.push(v);
  };
  return { db, connection, triggered, trigger };
}

const MAP = {
  version: 1,
  summary: "Acme helps brands track AI answers.",
  onboardingSteps: [
    { id: "run_audit", label: "Run your first audit", completion: "An audit's status is completed", path: "/dashboard/audits", detection: "server_event", confidence: "high", evidence: [{ path: "src/audits.ts", line: 3, excerpt: "status === 'completed'", verified: true }] },
    { id: "invite_team", label: "Invite your team", completion: "The workspace has more than one member", path: "/settings/team", detection: "reconcile", confidence: "medium", evidence: [] },
  ],
  events: [{ name: "audit.completed", label: "Audit completed", description: "An audit finished.", when: "When the audit worker sets status to completed", confidence: "high", evidence: [] }],
  traits: [{ key: "tier", type: "string", label: "Plan", description: "", confidence: "high", evidence: [] }],
  facts: [{ id: "visibility", label: "AI visibility", type: "number", unit: "%", description: "", source: "Daily snapshot", confidence: "high", evidence: [] }],
  glossary: [{ term: "GEO audit", definition: "A check of how AI engines see a site.", confidence: "high", evidence: [] }],
  hooks: [{ kind: "timezone", description: "Timezone isn't stored at sign-up.", confidence: "high", evidence: [] }],
  warnings: ["Timezone isn't stored at sign-up."],
};

describe("repo URLs", () => {
  it("accepts GitHub and GitLab repos only, normalised", () => {
    expect(parseRepoUrl("github.com/Acme/Web.git")).toEqual({ provider: "github", url: "https://github.com/Acme/Web", label: "web" });
    expect(parseRepoUrl("https://gitlab.com/acme/group/app")).toMatchObject({ provider: "gitlab", label: "app" });
    for (const bad of ["https://bitbucket.org/a/b", "http://github.com/a/b", "https://github.com/onlyowner", "https://github.com/a/b?x=1#y"]) {
      const r = parseRepoUrl(bad);
      if (bad.includes("?")) expect(r?.url).toBe("https://github.com/a/b");
      else expect(r).toBeNull();
    }
  });
});

describe("starting an analysis", () => {
  it("queues a read-only run and dispatches the Job with the tenant's region", async () => {
    const { db, connection, triggered, trigger } = await world();
    const r = await startRepoAnalysis(ctx, connection.id, { repos: [{ url: "github.com/acme/web", ref: "main" }, { url: "github.com/acme/web" }] }, { db, nowMs: NOW, trigger });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.analysis).toMatchObject({
      connectionId: connection.id,
      productName: "Acme",
      status: "queued",
      repos: [
        { provider: "github", url: "https://github.com/acme/web", ref: "main", label: "web" },
        { provider: "github", url: "https://github.com/acme/web", ref: null, label: "web-2" },
      ],
    });
    expect(triggered).toEqual([{ analysisId: r.value.analysis.id, tenantId: "ten_A", region: "eu" }]);
  });

  it("builds a Job request that only carries ids — no URLs or tokens", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "p";
    process.env.KNOWLEDGE_JOB_NAME = "knowledge-scraper";
    const req = buildProductMapRunRequest({ analysisId: "ra_1", tenantId: "ten_A", region: "eu" });
    expect(req.overrides.containerOverrides[0]!.env).toEqual([
      { name: "JOB_KIND", value: "product_map" },
      { name: "ANALYSIS_ID", value: "ra_1" },
      { name: "TENANT_ID", value: "ten_A" },
      { name: "REGION", value: "eu" },
    ]);
  });

  it("refuses bad input, other accounts' connections, a second run and the daily cap", async () => {
    const { db, connection, trigger } = await world();
    expect(await startRepoAnalysis(ctx, connection.id, { repos: [] }, { db, trigger })).toMatchObject({ ok: false, status: 400 });
    expect(await startRepoAnalysis(ctx, connection.id, { repos: [{ url: "https://evil.example/x/y" }] }, { db, trigger })).toMatchObject({ error: "invalid_repo_url" });
    const other: TenantContext = { ...ctx, tenantId: "ten_B" };
    expect(await startRepoAnalysis(other, connection.id, { repos: [{ url: "github.com/a/b" }] }, { db, trigger })).toMatchObject({ status: 404 });

    expect((await startRepoAnalysis(ctx, connection.id, { repos: [{ url: "github.com/a/b" }] }, { db, nowMs: NOW, trigger })).ok).toBe(true);
    expect(await startRepoAnalysis(ctx, connection.id, { repos: [{ url: "github.com/a/b" }] }, { db, nowMs: NOW, trigger })).toMatchObject({ error: "analysis_in_progress" });

    for (let i = 0; i < ANALYSES_PER_DAY; i += 1) {
      db.seed("repo_analyses", `ra_seed_${i}`, { tenantId: "ten_A", connectionId: "pcn_other", status: "done", createdAt: new Date(NOW - 1000).toISOString(), repos: [] });
    }
    expect(await startRepoAnalysis(ctx, connection.id, { repos: [{ url: "github.com/a/b" }] }, { db, nowMs: NOW, trigger })).toMatchObject({ status: 429, error: "analysis_daily_cap" });
  });

  it("marks the run failed when the Job isn't set up", async () => {
    const { db, connection } = await world();
    const r = await startRepoAnalysis(ctx, connection.id, { repos: [{ url: "github.com/a/b" }] }, {
      db,
      trigger: async () => {
        throw new Error("product_map_job_not_configured");
      },
    });
    expect(r).toMatchObject({ ok: false, status: 503, error: "job_not_configured" });
    const [a] = await listRepoAnalyses(ctx, connection.id, db);
    expect(a).toMatchObject({ status: "failed", error: "job_not_configured" });
  });
});

describe("accepting a product map", () => {
  async function withMap(map: unknown = MAP) {
    const w = await world();
    w.db.seed("repo_analyses", "ra_done", { tenantId: "ten_A", connectionId: w.connection.id, status: "done", map, createdAt: new Date(NOW).toISOString(), repos: [] });
    return w;
  }

  it("adds the chosen items, turning step paths into deep links on the app's domain", async () => {
    const { db, connection } = await withMap();
    const r = await acceptProductMap(ctx, connection.id, "ra_done", {
      steps: ["run_audit", "invite_team"],
      events: ["audit.completed"],
      traits: ["tier"],
      facts: ["visibility"],
      glossary: ["GEO audit"],
      appOrigin: "https://app.acme.test",
    }, { db, nowMs: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = r.value.catalog.onboardingSteps;
    // run_audit already existed: replaced in place. invite_team is new: appended.
    expect(steps.map((s) => s.id)).toEqual(["create_brand", "run_audit", "monitor_prompts", "invite_team"]);
    expect(steps[1]).toEqual({ id: "run_audit", label: "Run your first audit", url: "https://app.acme.test/dashboard/audits", order: 1, completion: "An audit's status is completed" });
    expect(steps[3]).toEqual({ id: "invite_team", label: "Invite your team", url: "https://app.acme.test/settings/team", order: 3, completion: "The workspace has more than one member" });
    expect(r.value.catalog.facts.map((f) => f.id)).toContain("visibility");
    expect(r.value.catalog.events.find((e) => e.name === "audit.completed")?.description).toContain("When the audit worker");
    expect(r.value.linkDomains).toContain("app.acme.test");
    expect(r.value.accepted).toEqual({ steps: 2, events: 1, traits: 1, facts: 1, glossary: 1 });
    const saved = await forTenant(ctx, db).productConnections.getById(connection.id);
    expect(saved?.catalog.facts.map((f) => f.id)).toContain("visibility");
    const [a] = await listRepoAnalyses(ctx, connection.id, db);
    expect(a).toMatchObject({ acceptedBy: "jez@acme.test", accepted: { steps: 2 } });
  });

  it("replaces an existing step with the same id instead of duplicating it", async () => {
    const { db, connection } = await withMap({ ...MAP, onboardingSteps: [{ ...MAP.onboardingSteps[0], id: "run_audit", label: "Run an audit (from code)" }] });
    const r = await acceptProductMap(ctx, connection.id, "ra_done", { steps: ["run_audit"] }, { db });
    expect(r.ok && r.value.catalog.onboardingSteps.filter((s) => s.id === "run_audit")).toEqual([
      expect.objectContaining({ label: "Run an audit (from code)", order: 1 }),
    ]);
  });

  it("refuses a non-https origin, a missing or malformed map, and another account", async () => {
    const { db, connection } = await withMap();
    expect(await acceptProductMap(ctx, connection.id, "ra_done", { steps: ["run_audit"], appOrigin: "http://app.acme.test" }, { db })).toMatchObject({ status: 400 });
    expect(await acceptProductMap({ ...ctx, tenantId: "ten_B" }, connection.id, "ra_done", {}, { db })).toMatchObject({ status: 404 });
    db.seed("repo_analyses", "ra_bad", { tenantId: "ten_A", connectionId: connection.id, status: "done", map: { onboardingSteps: "nope" }, createdAt: new Date(NOW).toISOString(), repos: [] });
    expect(await acceptProductMap(ctx, connection.id, "ra_bad", {}, { db })).toMatchObject({ status: 409, error: "no_map" });
  });
});
