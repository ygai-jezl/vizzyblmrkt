import { describe, expect, it } from "vitest";
import { capItems, isSettingsSubject, SETTINGS_LIMITS, SettingsVersionWriteSchema, type SettingsVersionItem, type SettingsVersionWrite } from "./settingsVersion";

const item = (n: number, extra: Record<string, unknown> = {}): SettingsVersionItem => ({
  key: `fld_${n}`,
  label: `Field ${n}`,
  change: "added",
  before: null,
  after: { key: `fld_${n}`, label: `Field ${n}`, ...extra },
});

const version = (over: Partial<SettingsVersionWrite> = {}): SettingsVersionWrite => ({
  subject: "fields:person",
  rev: 1,
  state: "live",
  savedAt: "2026-11-20T10:00:00.000Z",
  by: { type: "member", id: "usr_1" },
  message: null,
  source: "editor",
  restoredFrom: null,
  items: [item(1)],
  moreItems: 0,
  snapshot: { items: [{ key: "fld_1", label: "Field 1", type: "select" }] },
  ...over,
});

const issues = (v: unknown) => {
  const r = SettingsVersionWriteSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}:${i.message}`);
};

describe("a settings version", () => {
  it("accepts a plain save", () => {
    expect(issues(version())).toEqual([]);
  });

  it("refuses a snapshot over 256 KB", () => {
    const big = { items: [{ key: "fld_1", label: "Field 1", note: "x".repeat(SETTINGS_LIMITS.snapshotBytes) }] };
    expect(issues(version({ snapshot: big }))).toContain("snapshot:snapshot_too_large");
  });

  it("holds who saved it by id only, never an address", () => {
    expect(issues(version({ by: { type: "member", id: "sam@example.com" } })).join(" ")).toMatch(/^by\.id:/);
    expect(issues(version({ by: { type: "system", id: "script:scrub" } }))).toEqual([]);
    expect(issues(version({ by: { type: "agent", id: "aa_0123456789abcdef0123456789abcdef01234567" } }))).toEqual([]);
  });

  it("keeps restoredFrom to restores", () => {
    expect(issues(version({ source: "restore", restoredFrom: null }))).toContain("restoredFrom:restoredFrom_only_on_a_restore");
    expect(issues(version({ source: "editor", restoredFrom: 2 }))).toContain("restoredFrom:restoredFrom_only_on_a_restore");
    expect(issues(version({ source: "restore", restoredFrom: 2, rev: 3 }))).toEqual([]);
  });

  it("caps a message at 200 characters and refuses more than 50 items", () => {
    expect(issues(version({ message: "a".repeat(201) })).join(" ")).toMatch(/^message:/);
    expect(issues(version({ items: Array.from({ length: 51 }, (_, i) => item(i)) })).join(" ")).toMatch(/^items:/);
  });

  it("knows its subjects", () => {
    expect(isSettingsSubject("fields:person")).toBe(true);
    expect(isSettingsSubject("fields:company")).toBe(true);
    expect(isSettingsSubject("connections:shared")).toBe(true);
    expect(isSettingsSubject("fields:idea")).toBe(false);
  });
});

describe("capItems", () => {
  it("lists 50 of 51 items and counts the last", () => {
    const r = capItems(Array.from({ length: 51 }, (_, i) => item(i)));
    expect(r.items).toHaveLength(50);
    expect(r.moreItems).toBe(1);
    expect(r.items[0]!.key).toBe("fld_0");
  });

  it("stops before the items pass their byte cap", () => {
    const fat = Array.from({ length: 10 }, (_, i) => item(i, { note: "x".repeat(60 * 1024) }));
    const r = capItems(fat);
    expect(r.items.length).toBeLessThan(10);
    expect(r.items.length + r.moreItems).toBe(10);
    expect(issues(version({ items: r.items, moreItems: r.moreItems }))).toEqual([]);
  });

  it("keeps a short list whole", () => {
    expect(capItems([item(1), item(2)])).toEqual({ items: [item(1), item(2)], moreItems: 0 });
  });
});
