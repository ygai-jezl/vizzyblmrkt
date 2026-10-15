import type { BrandMapRecordStore, RecordKind } from "@/lib/tenant/brandMapRecords";
import type { BrandMapStoredRecord } from "@/lib/types/brandMapRecords";

/**
 * Create a record at the id its key gives it (keys.ts), once, however many ask at the same
 * moment: `created` when this call made it; `existing` when one with the same key is already
 * at that id (made a moment ago by another step, or before). Only when the id is held by a
 * record since renamed (another key) does the new one take a fresh id.
 */
export async function createOnce(
  store: BrandMapRecordStore,
  kind: RecordKind,
  id: string,
  data: Record<string, unknown>,
  opts: { same: (there: BrandMapStoredRecord) => boolean; fresh: () => string },
): Promise<{ created: BrandMapStoredRecord; existing?: undefined } | { existing: BrandMapStoredRecord; created?: undefined }> {
  const made = await store.createIfAbsent(kind, id, data);
  if (made) return { created: made };
  const there = await store.get(kind, id);
  if (there && opts.same(there)) return { existing: there };
  return { created: await store.create(kind, opts.fresh(), data) };
}
