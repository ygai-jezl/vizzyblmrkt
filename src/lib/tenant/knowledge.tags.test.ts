import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * setKnowledgeTags writes to the real chunk subcollection (it is tenant-layer code), so
 * the database handle is stubbed here with just the query chain and the batch it uses.
 */
const store = vi.hoisted(() => ({
  ids: [] as string[],
  queries: [] as { where: unknown[]; select: unknown[]; after: string | null; limit: number }[],
  batches: [] as { id: string; patch: unknown }[][],
  path: [] as string[],
}));

function queryFrom(state: { where: unknown[]; select: unknown[]; after: string | null }) {
  return {
    select: (...fields: unknown[]) => queryFrom({ ...state, select: fields }),
    startAfter: (doc: { id: string }) => queryFrom({ ...state, after: doc.id }),
    limit: (n: number) => ({
      get: async () => {
        store.queries.push({ ...state, limit: n });
        const from = state.after ? store.ids.indexOf(state.after) + 1 : 0;
        const docs = store.ids.slice(from, from + n).map((id) => ({ id, ref: { id } }));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    }),
  };
}

const firestore = {
  batch: () => {
    const writes: { id: string; patch: unknown }[] = [];
    return {
      update: (ref: { id: string }, patch: unknown) => void writes.push({ id: ref.id, patch }),
      commit: async () => void store.batches.push(writes),
    };
  },
};
const node = {
  collection: (name: string) => {
    store.path.push(name);
    return {
      firestore,
      doc: (id: string) => (store.path.push(id), node),
      where: (...args: unknown[]) => queryFrom({ where: args, select: ["(everything)"], after: null }),
    };
  },
};
vi.mock("./firestore", () => ({ getDb: () => node }));

import { setKnowledgeTags } from "./knowledge";
import type { TenantContext } from "./types";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

beforeEach(() => {
  store.ids = [];
  store.queries = [];
  store.batches = [];
  store.path = [];
});

describe("setKnowledgeTags", () => {
  it("re-stamps every chunk of one source, a page at a time, reading no text and no embedding", async () => {
    store.ids = Array.from({ length: 950 }, (_, i) => `tkt_1__${String(i).padStart(4, "0")}`);
    const n = await setKnowledgeTags(ctx, "workspace", "ws1", { ticketId: "tkt_1", tags: ["cite", "pricing"] });

    expect(n).toBe(950);
    expect(store.path).toEqual(["workspaces", "ws1", "knowledge_bases"]);
    // Three pages: each carries on from the last chunk the one before it saw.
    expect(store.queries.map((q) => [q.after, q.limit])).toEqual([
      [null, 400],
      ["tkt_1__0399", 400],
      ["tkt_1__0799", 400],
    ]);
    expect(store.queries.every((q) => JSON.stringify(q.where) === JSON.stringify(["ticketId", "==", "tkt_1"]))).toBe(true);
    // Refs only.
    expect(store.queries.every((q) => q.select.length === 0)).toBe(true);
    expect(store.batches.map((b) => b.length)).toEqual([400, 400, 150]);
    expect(store.batches.flat().every((w) => JSON.stringify(w.patch) === JSON.stringify({ tags: ["cite", "pricing"] }))).toBe(true);
    expect(new Set(store.batches.flat().map((w) => w.id)).size).toBe(950);
  });

  it("writes nothing for a source with no chunks", async () => {
    expect(await setKnowledgeTags(ctx, "workspace", "ws1", { ticketId: "tkt_none", tags: [] })).toBe(0);
    expect(store.batches).toEqual([]);
  });
});
