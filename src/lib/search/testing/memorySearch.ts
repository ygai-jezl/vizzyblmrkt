import { MemorySearchIndex } from "../memoryStore";

/**
 * Brand search for tests that reach it without passing a store: removals of the brand map family
 * are forced whatever the switches say (ADR-0025), so without this they would try a real database.
 *
 *   vi.mock("@/lib/tenant/searchIndex", async (original) =>
 *     (await import("@/lib/search/testing/memorySearch")).withMemorySearch(await original()));
 *
 * Every brand's store is in `testSearchIndex`, one map shared by the test file.
 */
export const testSearchIndex = new MemorySearchIndex();

export function withMemorySearch<T extends object>(original: T): T & { searchStoreFor: (ctx: { tenantId: string }) => ReturnType<MemorySearchIndex["storeFor"]> } {
  return { ...original, searchStoreFor: (ctx: { tenantId: string }) => testSearchIndex.storeFor(ctx) };
}
