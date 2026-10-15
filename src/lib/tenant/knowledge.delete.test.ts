import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deleteOwnerKnowledge deletes from the real subcollections (it is tenant-layer code), so
 * the database handle is stubbed here with just the query chain and the batch it uses.
 */
const store = vi.hoisted(() => ({
  docs: {} as Record<string, string[]>,
  deleted: {} as Record<string, string[]>,
  wheres: {} as Record<string, unknown[]>,
}));

function collection(name: string) {
  const query = (where: unknown[] | null) => ({
    select: () => ({
      limit: (n: number) => ({
        get: async () => {
          if (where) store.wheres[name] = where;
          const ids = (store.docs[name] ?? []).slice(0, n);
          return { empty: ids.length === 0, size: ids.length, docs: ids.map((id) => ({ id, ref: { name, id } })) };
        },
      }),
    }),
  });
  return {
    firestore: {
      batch: () => {
        const refs: { name: string; id: string }[] = [];
        return {
          delete: (ref: { name: string; id: string }) => void refs.push(ref),
          commit: async () => {
            for (const r of refs) {
              store.docs[r.name] = (store.docs[r.name] ?? []).filter((id) => id !== r.id);
              (store.deleted[r.name] ??= []).push(r.id);
            }
          },
        };
      },
    },
    where: (...args: unknown[]) => query(args),
    ...query(null),
  };
}
const node = { collection: () => ({ doc: () => ({ collection }) }) };
vi.mock("./firestore", () => ({ getDb: () => node }));

import { deleteOwnerKnowledge } from "./knowledge";
import type { TenantContext } from "./types";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

beforeEach(() => {
  store.docs = { knowledge_bases: ["c1", "c2", "c3"], knowledge_pages: ["p1", "p2"] };
  store.deleted = {};
  store.wheres = {};
});

describe("deleteOwnerKnowledge", () => {
  it("takes a source's page records with its chunks, and counts the chunks", async () => {
    expect(await deleteOwnerKnowledge(ctx, "workspace", "ws1", { ticketId: "tkt_1" })).toBe(3);
    expect(store.deleted).toEqual({ knowledge_bases: ["c1", "c2", "c3"], knowledge_pages: ["p1", "p2"] });
    expect(store.wheres).toEqual({ knowledge_bases: ["ticketId", "==", "tkt_1"], knowledge_pages: ["ticketId", "==", "tkt_1"] });
  });
});
