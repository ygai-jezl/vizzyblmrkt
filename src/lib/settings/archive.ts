import type { SettingsItem, SettingsItemChange, SettingsVersionItem } from "@/lib/types/settingsVersion";

/**
 * Archive, never delete (piece O): a setting's items, such as a brand's People fields, are
 * archived instead of removed, so the values saved under them and the history that names them
 * always have something to point at. Changing what an item is (a field's type) makes a new item
 * and archives the old one with `replacedBy`. Pure.
 *
 * commitSettingsChange (src/lib/tenant/settingsLog.ts) calls assertNoRemoval on every save, so
 * no caller can drop an item by mistake.
 */

/** A save would lose items instead of archiving them. Names their keys, never a value. */
export class SettingsRemovalError extends Error {
  constructor(readonly keys: string[]) {
    super(`settings_item_removed:${keys.join(",")}`);
    this.name = "SettingsRemovalError";
  }
}

export function isArchived(item: Pick<SettingsItem, "archivedAt">): boolean {
  return !!item.archivedAt;
}

function indexOfKey(items: readonly SettingsItem[], key: string): number {
  const i = items.findIndex((it) => it.key === key);
  if (i < 0) throw new Error(`settings_item_not_found:${key}`);
  return i;
}

/** Archive one item. One already archived keeps the time it was archived. */
export function archiveItem<I extends SettingsItem>(items: readonly I[], key: string, nowIso: string): I[] {
  const i = indexOfKey(items, key);
  if (isArchived(items[i]!)) return [...items];
  return items.map((it, j) => (j === i ? { ...it, archivedAt: nowIso } : it));
}

/** Bring an archived item back, as it was, with no replacement noted. */
export function restoreItem<I extends SettingsItem>(items: readonly I[], key: string): I[] {
  const i = indexOfKey(items, key);
  return items.map((it, j) => (j === i ? { ...it, archivedAt: null, replacedBy: null } : it));
}

/**
 * Change what an item is: `replacement` is added under a new key, and the old item is archived
 * with `replacedBy` naming it. Values saved under the old key stay where they are.
 */
export function changeType<I extends SettingsItem>(items: readonly I[], key: string, replacement: I, nowIso: string): I[] {
  const i = indexOfKey(items, key);
  if (replacement.key === key || items.some((it) => it.key === replacement.key)) throw new Error(`settings_item_exists:${replacement.key}`);
  const old = items[i]!;
  return [
    ...items.map((it, j) => (j === i ? { ...it, archivedAt: old.archivedAt || nowIso, replacedBy: replacement.key } : it)),
    { ...replacement, archivedAt: null, replacedBy: null },
  ];
}

/** Refuse a save where an item disappears instead of being archived. */
export function assertNoRemoval(before: readonly SettingsItem[], after: readonly SettingsItem[]): void {
  const kept = new Set(after.map((it) => it.key));
  const lost = before.filter((it) => !kept.has(it.key)).map((it) => it.key);
  if (lost.length) throw new SettingsRemovalError(lost);
}

/** JSON with object keys sorted, so two equal items compare equal whatever order they were built in. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Whether two items are the same, ignoring key order and missing versus undefined. */
export function sameItem(a: SettingsItem, b: SettingsItem): boolean {
  return stableJson(a) === stableJson(b);
}

/**
 * What changed between two versions of a setting, item by item, in the order of `after`: added,
 * archived, restored (brought back from the archive) or changed. Unchanged items are left out.
 */
export function describeItemChanges<I extends SettingsItem>(before: readonly I[], after: readonly I[]): SettingsVersionItem[] {
  const was = new Map(before.map((it) => [it.key, it]));
  const out: SettingsVersionItem[] = [];
  for (const now of after) {
    const old = was.get(now.key);
    let change: SettingsItemChange | null;
    if (!old) change = "added";
    else if (!isArchived(old) && isArchived(now)) change = "archived";
    else if (isArchived(old) && !isArchived(now)) change = "restored";
    else change = sameItem(old, now) ? null : "changed";
    if (!change) continue;
    out.push({
      key: now.key,
      label: now.label,
      change,
      before: old ? ({ ...old } as Record<string, unknown>) : null,
      after: { ...now } as Record<string, unknown>,
    });
  }
  return out;
}

const VERBS: Record<SettingsItemChange, string> = { added: "Added", changed: "Changed", archived: "Archived", restored: "Restored" };

/** One item's change in plain words, as describeChanges words a catalog's: "Added ‘Plan’". */
export function itemChangeText(item: Pick<SettingsVersionItem, "change" | "label">): string {
  return `${VERBS[item.change]} ‘${item.label}’`;
}
