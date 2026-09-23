import { describe, it, expect, beforeAll } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { createConnection } from "./keys";
import { SANDBOX_CATALOG } from "./sandbox";
import { agentGetRepoAnalysis } from "./agentRepoAnalysis";

const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "agent", role: "admin" };

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});

describe("Vizzy's view of a repo analysis", () => {
  it("summarises items and gaps without any code excerpts", async () => {
    const db = new FakeFirestore();
    const { connection } = await createConnection(ctx, { name: "Acme", kind: "custom", catalog: SANDBOX_CATALOG }, db);
    db.seed("repo_analyses", "ra_1", {
      tenantId: "ten_A",
      connectionId: connection.id,
      status: "done",
      createdAt: "2026-09-23T10:00:00Z",
      repos: [{ provider: "github", url: "https://github.com/acme/web", ref: "main", label: "web" }],
      stats: { files: 10, items: 2, verifiedItems: 1, turns: 3, toolCalls: 5, inputTokens: 1, outputTokens: 1, submitted: true, dropped: 0, evidence: 1, verifiedEvidence: 1 },
      map: {
        summary: "Acme.",
        facts: [{ id: "visibility", label: "Visibility", evidence: [{ path: "src/secret-sauce.ts", excerpt: "const PRIVATE_ALGO = 42", verified: true }] }],
        hooks: [{ kind: "timezone", description: "Timezone isn't stored." }],
      },
    });
    const r = await agentGetRepoAnalysis(ctx, connection.id, db);
    expect(r.status).toBe(200);
    const body = r.body as { analysis: { map: { facts: unknown[]; hooks: unknown[] }; reviewUrl: string } };
    expect(body.analysis.map.facts).toEqual([{ id: "visibility", label: "Visibility", unit: null, source: "", confidence: "medium", backedByCode: true }]);
    expect(body.analysis.reviewUrl).toBe(`/admin/products/${connection.id}`);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("PRIVATE_ALGO");
    expect(text).not.toContain("secret-sauce");
  });

  it("says when there's no analysis yet", async () => {
    const db = new FakeFirestore();
    const { connection } = await createConnection(ctx, { name: "Acme", kind: "custom" }, db);
    expect((await agentGetRepoAnalysis(ctx, connection.id, db)).body).toMatchObject({ analysis: null });
  });
});
