import { describe, it, expect, afterEach, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { enqueueIngestionTicket, ingestionDedupeKey } from "./tickets";
import type { TenantContext } from "@/lib/tenant/types";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const input = {
  ownerKind: "workspace" as const,
  ownerId: "ws1",
  source: "github" as const,
  sourceUri: "https://github.com/org/repo",
  ref: null,
  topic: "systems",
  tags: [],
};

afterEach(() => vi.unstubAllEnvs());

describe("ingestionDedupeKey", () => {
  it("is deterministic and tenant-scoped", () => {
    const a = ingestionDedupeKey("ten_A", input);
    const b = ingestionDedupeKey("ten_A", input);
    const other = ingestionDedupeKey("ten_B", input);
    expect(a).toBe(b);
    expect(a).not.toBe(other); // different tenant → different id (no cross-tenant collision)
    expect(a.startsWith("tkt_")).toBe(true);
  });

  it("includes includeGlobs so differently-scoped ingests are distinct tickets", () => {
    const src = ingestionDedupeKey("ten_A", { ...input, includeGlobs: ["src/**"] });
    const docs = ingestionDedupeKey("ten_A", { ...input, includeGlobs: ["docs/**"] });
    const none = ingestionDedupeKey("ten_A", input);
    expect(src).not.toBe(docs);
    expect(src).not.toBe(none);
  });
});

describe("enqueueIngestionTicket", () => {
  it("creates a pending ticket and dedupes a re-post", async () => {
    const db = new FakeFirestore();
    const first = await enqueueIngestionTicket(ctx, input, db);
    expect(first.status).toBe("created");
    const raw = db.raw("ingestion_tickets", first.ticketId!)!;
    expect(raw.tenantId).toBe("ten_A");
    expect(raw.status).toBe("pending");
    expect(raw.region).toBe("us");

    const second = await enqueueIngestionTicket(ctx, input, db);
    expect(second.status).toBe("duplicate");
    expect(second.ticketId).toBe(first.ticketId);
  });

  it("rate-limits when the tenant is at its active cap", async () => {
    vi.stubEnv("KNOWLEDGE_MAX_ACTIVE_INGESTIONS", "2");
    const db = new FakeFirestore();
    db.seed("ingestion_tickets", "t1", { tenantId: "ten_A", status: "pending" });
    db.seed("ingestion_tickets", "t2", { tenantId: "ten_A", status: "running" });
    // A different tenant's active tickets do not count.
    db.seed("ingestion_tickets", "t3", { tenantId: "ten_B", status: "pending" });

    const res = await enqueueIngestionTicket(
      ctx,
      { ...input, sourceUri: "https://github.com/org/another" },
      db,
    );
    expect(res.status).toBe("rate_limited");
  });

  it("does not count finished/failed tickets against the cap", async () => {
    vi.stubEnv("KNOWLEDGE_MAX_ACTIVE_INGESTIONS", "1");
    const db = new FakeFirestore();
    db.seed("ingestion_tickets", "done1", { tenantId: "ten_A", status: "done" });
    db.seed("ingestion_tickets", "failed1", { tenantId: "ten_A", status: "failed" });
    const res = await enqueueIngestionTicket(ctx, input, db);
    expect(res.status).toBe("created");
  });

  it("re-ingests a TERMINAL ticket: resets it to pending and reports 'retried'", async () => {
    const db = new FakeFirestore();
    const first = await enqueueIngestionTicket(ctx, input, db);
    const id = first.ticketId!;
    // Simulate the worker finishing the run.
    db.seed("ingestion_tickets", id, {
      ...db.raw("ingestion_tickets", id)!,
      status: "done",
      chunksWritten: 5,
      finishedAt: "2026-06-29T00:00:00Z",
    });

    const retried = await enqueueIngestionTicket(ctx, input, db);
    expect(retried.status).toBe("retried");
    expect(retried.ticketId).toBe(id);
    const raw = db.raw("ingestion_tickets", id)!;
    expect(raw.status).toBe("pending");
    expect(raw.chunksWritten).toBe(0);
    expect(raw.finishedAt).toBeNull();
  });

  it("returns 'duplicate' (not rate_limited) for an in-flight re-post even at the cap", async () => {
    vi.stubEnv("KNOWLEDGE_MAX_ACTIVE_INGESTIONS", "1");
    const db = new FakeFirestore();
    const first = await enqueueIngestionTicket(ctx, input, db); // 1 active → at cap
    expect(first.status).toBe("created");
    const again = await enqueueIngestionTicket(ctx, input, db); // same in-flight source
    expect(again.status).toBe("duplicate"); // idempotent, not a 429
  });

  it("remembers a source read as one page, and keeps it so on a re-ingest that doesn't say", async () => {
    const db = new FakeFirestore();
    const page = { ...input, source: "docs_url" as const, sourceUri: "https://research.example.org/report" };

    // Not said at all: nothing new is stored, and the job crawls as it always has.
    const crawl = await enqueueIngestionTicket(ctx, { ...page, sourceUri: "https://acme.example" }, db);
    expect(crawl).toMatchObject({ status: "created", onePage: false });
    expect("onePage" in db.raw("ingestion_tickets", crawl.ticketId!)!).toBe(false);

    const first = await enqueueIngestionTicket(ctx, { ...page, onePage: true }, db);
    expect(first).toMatchObject({ status: "created", onePage: true });
    const id = first.ticketId!;
    expect(db.raw("ingestion_tickets", id)!.onePage).toBe(true);

    // Still being read: the answer says what the source is.
    expect(await enqueueIngestionTicket(ctx, page, db)).toMatchObject({ status: "duplicate", onePage: true });

    db.seed("ingestion_tickets", id, { ...db.raw("ingestion_tickets", id)!, status: "done" });
    expect(await enqueueIngestionTicket(ctx, page, db)).toMatchObject({ status: "retried", onePage: true });
    expect(db.raw("ingestion_tickets", id)!.onePage).toBe(true);

    // Said otherwise: it is crawled again from now on.
    db.seed("ingestion_tickets", id, { ...db.raw("ingestion_tickets", id)!, status: "done" });
    expect(await enqueueIngestionTicket(ctx, { ...page, onePage: false }, db)).toMatchObject({ status: "retried", onePage: false });
    expect(db.raw("ingestion_tickets", id)!.onePage).toBe(false);
  });
});
