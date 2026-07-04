import { describe, it, expect, afterEach } from "vitest";
import { retrieveExemplars } from "./retrieveExemplars";
import type { TenantContext, KnowledgeCollectionLike } from "@/lib/tenant/types";

const ctx: TenantContext = { tenantId: "ten_1", region: "us", source: "system" };

/** Fake vector collection: where() returns self, findNearest().get() yields docs. */
function fakeExemplars(docs: Array<Record<string, unknown>>): KnowledgeCollectionLike {
  const self: KnowledgeCollectionLike = {
    where: () => self,
    findNearest: () => ({
      get: async () => ({
        empty: docs.length === 0,
        size: docs.length,
        docs: docs.map((d, i) => ({ id: `e${i}`, data: () => d })),
      }),
    }),
  } as unknown as KnowledgeCollectionLike;
  return self;
}

const exemplar = (over: Record<string, unknown> = {}) => ({
  tenantId: "ten_1",
  channel: "x",
  text: "A proven hook that worked",
  tags: ["hook:question"],
  ...over,
});

const embed = async () => [0.1, 0.2];
const req = { ctx, channel: "x", queryText: "a new post about growth", bypassEnabledFlag: true };

afterEach(() => {
  delete process.env.DISTRIBUTE_CLOSED_LOOP_ENABLED;
});

describe("retrieveExemplars", () => {
  it("is gated OFF by default (returns null unless flag or bypass)", async () => {
    const res = await retrieveExemplars(
      { ctx, channel: "x", queryText: "hi" },
      { embed, exemplars: fakeExemplars([exemplar()]) },
    );
    expect(res).toBeNull();
  });

  it("returns channel-matched exemplars + a formatted 'proven' block when enabled", async () => {
    process.env.DISTRIBUTE_CLOSED_LOOP_ENABLED = "true";
    const res = await retrieveExemplars(
      { ctx, channel: "x", queryText: "growth" },
      { embed, exemplars: fakeExemplars([exemplar()]) },
    );
    expect(res).not.toBeNull();
    expect(res!.exemplars).toHaveLength(1);
    expect(res!.formatted).toContain("PROVEN HIGH-PERFORMING EXAMPLES");
    expect(res!.formatted).toContain("A proven hook that worked");
    expect(res!.formatted).toContain("hook:question");
  });

  it("defence in depth: drops foreign-tenant and wrong-channel rows", async () => {
    const res = await retrieveExemplars(req, {
      embed,
      exemplars: fakeExemplars([
        exemplar({ tenantId: "ten_OTHER" }),
        exemplar({ channel: "linkedin" }),
        exemplar({ text: "kept one" }),
      ]),
    });
    expect(res!.exemplars).toHaveLength(1);
    expect(res!.exemplars[0]!.text).toBe("kept one");
  });

  it("fail-soft: null when the embed fails", async () => {
    const res = await retrieveExemplars(req, { embed: async () => null, exemplars: fakeExemplars([exemplar()]) });
    expect(res).toBeNull();
  });

  it("returns an empty block when there are no exemplars", async () => {
    const res = await retrieveExemplars(req, { embed, exemplars: fakeExemplars([]) });
    expect(res!.exemplars).toHaveLength(0);
    expect(res!.formatted).toBe("");
  });
});
