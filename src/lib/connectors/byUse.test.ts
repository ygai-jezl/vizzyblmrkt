import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { createDataConnection, type TenantContext } from "@/lib/tenant";
import { freshCollect, type ConnectionGrant } from "@/lib/types/dataConnection";
import { readByUse, streamForUse, type UseDeps } from "./byUse";
import { healthyAt } from "./health";
import { rolledId } from "./keys";
import type { LiveAnswer } from "./live";
import { parseManifest, type ConnectorManifest, type ConnectorManifestInput } from "./manifest";
import { putSnapshot, ttlFor } from "./snapshots";
import { PLANNING } from "./testing/signals";
import { testMcpManifest } from "./testing/mcpServer";

// The reader features use for a kind of data (ADR-0019). The connector is made up, and so is
// every number; the live read is a stub, so nothing calls a provider.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const B: TenantContext = { tenantId: "ten_b", region: "us", source: "idtoken", userId: "usr_b", role: "admin" };
const NOW = new Date("2026-11-21T10:00:00.000Z");

/** The made-up MCP connector, declaring AI answers. */
const answers: ConnectorManifest = { ...parseManifest(testMcpManifest), uses: ["vizzy.read", "signals.ai_answers"] };
/** Another made-up connector that doesn't. */
const other: ConnectorManifest = { ...parseManifest({ ...(testMcpManifest as unknown as ConnectorManifestInput), id: "acme-other", name: "Acme Other" }), uses: ["vizzy.read"] };
const manifestOf = (id: string) => (id === answers.id ? answers : id === other.id ? other : null);

let db: FakeFirestore;
async function seed(ctx: TenantContext, id: string, over: { connectorId?: string; grants?: ConnectionGrant[]; account?: string; status?: "connected" | "disconnected" } = {}) {
  const at = "2026-11-01T10:00:00.000Z";
  await createDataConnection(
    ctx,
    {
      id,
      connectorId: over.connectorId ?? answers.id,
      method: "token_fields",
      label: "Acme",
      account: over.account ?? "acme.example",
      ownerUid: "usr_admin",
      grants: over.grants ?? PLANNING,
      secrets: {},
      health: healthyAt(new Date(at)),
      pausedAt: null,
      pausedBy: null,
      status: over.status ?? "connected",
      createdAt: at,
      updatedAt: at,
      disconnectedAt: over.status === "disconnected" ? at : null,
      collect: freshCollect(at),
    },
    [{ kind: "connected", by: "usr_admin", at }],
    db,
  );
}

const liveAnswer = (stream: string, rows: LiveAnswer["rows"]): LiveAnswer => ({
  connectorId: answers.id,
  connector: answers.name,
  stream,
  by: "topic",
  period: { from: "2026-10-24", to: "2026-11-20", timeZone: "UTC", finalThrough: "2026-11-20", words: "24 Oct to 20 Nov 2026, UTC" },
  rows,
  totals: null,
  more: false,
  meanings: {},
  notes: ["made-up note"],
  asOf: NOW.toISOString(),
});

function deps(over: Partial<UseDeps> = {}) {
  const live = vi.fn(async (_ctx: TenantContext, _actor: unknown, id: string, query: unknown) => ({ ok: true as const, status: 200 as const, value: liveAnswer((query as { stream: string }).stream, [{ prompt: `best tools for ${id}`, cfVisits: 3 }]) }));
  return { live, deps: { db, job: "next_up" as const, manifestOf, live, now: NOW, ...over } };
}

beforeEach(() => {
  db = new FakeFirestore();
});
afterEach(() => vi.unstubAllEnvs());

describe("readByUse", () => {
  it("reads only connections whose manifest declares the use and that feed planning, as the next_up job", async () => {
    await seed(A, "dcn_aaaaaaaaaaaaaaaaaaaa");
    await seed(A, "dcn_bbbbbbbbbbbbbbbbbbbb", { grants: [{ to: "members", can: "read" }] });
    await seed(A, "dcn_cccccccccccccccccccc", { connectorId: other.id });
    await seed(A, "dcn_dddddddddddddddddddd", { status: "disconnected" });
    await seed(A, "dcn_eeeeeeeeeeeeeeeeeeee", { account: "" });
    const { live, deps: d } = deps();
    const r = await readByUse(A, "signals.ai_answers", { measures: ["cfVisits"], by: "topic", period: "last_28_days" }, d);
    expect(r.failed).toEqual([]);
    expect(r.reads).toHaveLength(1);
    expect(r.reads[0]).toMatchObject({
      connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa",
      connectorId: "acme-answers",
      stream: "now",
      from: "live",
      // Keys by the shared key they join on, numbers by meaning: a feature never sees a provider's field names.
      rows: [{ keys: { topic: "best tools for dcn_aaaaaaaaaaaaaaaaaaaa" }, m: { cfVisits: 3 } }],
      notes: ["made-up note"],
    });
    expect(Object.keys(r.reads[0]!.meanings)).toEqual(["cfVisits"]);
    expect(live).toHaveBeenCalledTimes(1);
    expect(live.mock.calls[0]![1]).toEqual({ kind: "job", job: "next_up" });
    expect(live.mock.calls[0]![3]).toEqual({ stream: "now", period: "last_28_days", by: "topic", limit: 100 });
  });

  it("never reads another brand's connection", async () => {
    await seed(B, "dcn_bbbbbbbbbbbbbbbbbbbb");
    const { live, deps: d } = deps();
    expect(await readByUse(A, "signals.ai_answers", { measures: ["cfVisits"], by: "topic", period: "last_28_days" }, d)).toEqual({ reads: [], failed: [] });
    expect(live).not.toHaveBeenCalled();
    expect((await readByUse(B, "signals.ai_answers", { measures: ["cfVisits"], by: "topic", period: "last_28_days" }, d)).reads.map((x) => x.connectionId)).toEqual(["dcn_bbbbbbbbbbbbbbbbbbbb"]);
  });

  it("reads nothing for a use no manifest declares, or numbers no stream gives", async () => {
    await seed(A, "dcn_aaaaaaaaaaaaaaaaaaaa");
    const { live, deps: d } = deps();
    expect((await readByUse(A, "signals.bots", { measures: ["cfVisits"], by: "topic", period: "last_28_days" }, d)).reads).toEqual([]);
    expect((await readByUse(A, "signals.ai_answers", { measures: ["cfVisits", "searchClicks"], by: "topic", period: "last_28_days" }, d)).reads).toEqual([]);
    // A stream read for one page only is never picked for a whole account.
    expect(streamForUse(answers, { measures: ["cfPageViews"], by: "page" })).toBeNull();
    expect(live).not.toHaveBeenCalled();
  });

  it("leaves a failed read out with its code, and goes on with the others", async () => {
    await seed(A, "dcn_aaaaaaaaaaaaaaaaaaaa");
    await seed(A, "dcn_bbbbbbbbbbbbbbbbbbbb", { account: "other.example" });
    const live = vi.fn(async (_c: TenantContext, _a: unknown, id: string) =>
      id === "dcn_aaaaaaaaaaaaaaaaaaaa" ? { ok: false as const, status: 409 as const, error: "token_refused" } : { ok: true as const, status: 200 as const, value: liveAnswer("now", []) },
    );
    const r = await readByUse(A, "signals.ai_answers", { measures: ["cfVisits"], by: "topic", period: "last_28_days" }, { ...deps().deps, live });
    expect(r.failed).toEqual([{ connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa", code: "token_refused" }]);
    expect(r.reads.map((x) => x.connectionId)).toEqual(["dcn_bbbbbbbbbbbbbbbbbbbb"]);
  });

  it("reads collected numbers where the stream keeps them for the period, while collecting is on", async () => {
    await seed(A, "dcn_aaaaaaaaaaaaaaaaaaaa");
    await putSnapshot(
      A,
      rolledId("dcn_aaaaaaaaaaaaaaaaaaaa", 0, "daily", "day", "r28"),
      {
        connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa",
        gen: 0,
        account: "acme.example",
        connectorId: answers.id,
        stream: "daily",
        by: "day",
        day: null,
        window: { from: "2026-10-24", to: "2026-11-20" },
        days: 28,
        timeZone: "UTC",
        final: true,
        totals: { cfRequests: 21 },
        rows: [
          { key: "2026-11-19", m: { cfRequests: 9 } },
          { key: "2026-11-20", m: { cfRequests: 12 } },
        ],
        rowsSeen: 2,
        rowsDropped: 0,
        more: false,
        floor: null,
        basis: null,
        notes: [],
        collectedAt: NOW.toISOString(),
        ttlAt: ttlFor("2026-11-20", 90),
      },
      { db },
    );
    const ask = { measures: ["cfRequests"] as const, by: "day" as const, period: "last_28_days" as const };
    const { live, deps: d } = deps();
    // Collecting off: read live.
    expect((await readByUse(A, "signals.ai_answers", ask, d)).reads[0]!.from).toBe("live");
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    const r = await readByUse(A, "signals.ai_answers", ask, d);
    expect(r.reads[0]).toMatchObject({ from: "collected", stream: "daily", period: { from: "2026-10-24", to: "2026-11-20", timeZone: "UTC" }, rows: [{ keys: { day: "2026-11-19" }, m: { cfRequests: 9 } }, { keys: { day: "2026-11-20" }, m: { cfRequests: 12 } }] });
    expect(live).toHaveBeenCalledTimes(1);
    // A period no rolled doc keeps is read live.
    expect((await readByUse(A, "signals.ai_answers", { ...ask, period: "last_7_days" }, d)).reads[0]!.from).toBe("live");
  });
});
