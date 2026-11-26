import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { readFieldList, saveFieldListChange } from "@/lib/audience/fieldList";
import type { FirestoreLike } from "@/lib/tenant/types";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { BEFORE_HISTORY_TEXT, decodeCursor, listHistory, parseHistorySubject, type HistoryPage } from "./sources";
import { addTeamViews, buildWorld, ctx, lookup, member, switchesOn, T, viewsOn, type World } from "./testing/world";

let w: World;
beforeEach(async () => {
  switchesOn();
  w = await buildWorld();
});
afterEach(() => vi.unstubAllEnvs());

async function page(opts: Parameters<typeof listHistory>[1] = {}, db: FirestoreLike = w.db): Promise<HistoryPage> {
  const r = await listHistory(ctx, opts, { db, lookup });
  if (!r.ok) throw new Error(r.error);
  return r.page;
}
const line = (e: HistoryPage["entries"][number]) => `${e.name} v${e.rev} · ${e.by}`;

describe("listHistory", () => {
  it("merges every kind newest first, for this brand only, with who in words", async () => {
    const p = await page();
    expect(p.entries.map(line)).toEqual([
      "People fields v4 · Maya Chen",
      "Product catalog ‘Sandbox’ v3 · Maya Chen",
      "Journey ‘Welcome to the greenhouse’ v2 · Maya Chen",
      "Shared connections v1 · An owner of your organisation",
      "Product catalog ‘Sandbox’ v2 · Former team member",
      "People fields v3 · Former team member",
      "Journey ‘Welcome to the greenhouse’ v1 · Former team member",
      "Company fields v1 · Maya Chen",
      "People fields v2 · Maya Chen",
      "People fields v1 · Maya Chen",
      "Product catalog ‘Sandbox’ v1 · YouGrow",
    ]);
    expect(p.next).toBeNull();
    expect(p.partial).toBe(false);
    expect(p.kinds.map((k) => k.label)).toEqual(["Fields", "Journeys", "Product catalogs", "Shared connections"]);
    expect(JSON.stringify(p)).not.toContain("Secret");
    expect(JSON.stringify(p)).not.toMatch(/@/);
  });

  it("says what each entry is: the live journey, a draft, read only and what changed", async () => {
    const { entries } = await page();
    const v2 = entries.find((e) => e.kind === "journeys" && e.rev === 2)!;
    expect(v2).toMatchObject({ live: true, message: "Published.", canRestore: true, canExport: true, readOnly: null, draft: null });
    expect(entries.find((e) => e.kind === "journeys" && e.rev === 1)).toMatchObject({ live: false });
    expect(entries.find((e) => e.kind === "connections")).toMatchObject({ readOnly: "shared", canRestore: false, canExport: true, message: "Gave ‘Google Analytics, fernhill.example’" });
    expect(entries.find((e) => e.kind === "catalogs" && e.rev === 1)).toMatchObject({ message: BEFORE_HISTORY_TEXT, by: "YouGrow" });
    expect(entries.find((e) => e.kind === "catalogs" && e.rev === 3)!.items).toEqual(["Renamed step ‘Run an audit’ to ‘First visit’"]);
    expect(entries.find((e) => e.subject === "fields:person" && e.rev === 4)).toMatchObject({ message: "Archived ‘Delivery day’", items: ["Archived ‘Delivery day’"], archivedKeys: ["fld_000000000002"] });
    expect(entries.find((e) => e.subject === "fields:person" && e.rev === 3)!.archivedKeys).toEqual([]);
  });

  it("pages with one cursor that holds each source's place, never repeating or skipping", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p = await page({ limit: 4, cursor });
      seen.push(...p.entries.map(line));
      cursor = p.next;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual((await page()).entries.map(line));
    expect(decodeCursor("not a cursor")).toBeNull();
    expect(await listHistory(ctx, { cursor: "bm90IG91cnM" }, { db: w.db, lookup })).toEqual({ ok: false, error: "invalid_cursor" });
  });

  it("filters by kind, and by one setting, journey or product", async () => {
    expect((await page({ kind: "fields" })).entries.map(line)).toEqual([
      "People fields v4 · Maya Chen",
      "People fields v3 · Former team member",
      "Company fields v1 · Maya Chen",
      "People fields v2 · Maya Chen",
      "People fields v1 · Maya Chen",
    ]);
    expect((await page({ subject: "fields:company" })).entries.map((e) => e.rev)).toEqual([1]);
    const journey = await page({ subject: `journey:${w.journeyId}`, limit: 1 });
    expect(journey.entries.map((e) => e.rev)).toEqual([2]);
    expect((await page({ subject: `journey:${w.journeyId}`, cursor: journey.next })).entries.map((e) => e.rev)).toEqual([1]);
    expect((await page({ subject: "catalog:pcn_life" })).entries.map((e) => e.rev)).toEqual([3, 2, 1]);
    expect(await listHistory(ctx, { subject: "journey:../x" }, { db: w.db })).toEqual({ ok: false, error: "invalid_subject" });
    expect(parseHistorySubject("catalog:pcn_life")).toEqual({ kind: "catalogs", store: "catalogs", connectionId: "pcn_life" });
  });

  it("never reads more of one journey's versions than it has, whatever place a cursor claims", async () => {
    const key = `journey:${w.journeyId}`;
    // Every read by id goes through the repository: count those of journey versions.
    const getById = vi.spyOn(Object.getPrototypeOf(forTenant(ctx, w.db).lifecycleVersions) as { getById: () => unknown }, "getById");
    const versionReads = () => getById.mock.contexts.filter((c) => (c as { name?: string }).name === "lifecycle_versions").length;
    for (const place of [200_000, Number.MAX_SAFE_INTEGER]) {
      getById.mockClear();
      const cursor = Buffer.from(JSON.stringify({ v: 1, p: { [key]: place } }), "utf8").toString("base64url");
      const r = await listHistory(member, { subject: key, cursor }, { db: w.db, lookup });
      expect(r.ok && r.page.entries.map((e) => e.rev)).toEqual([2, 1]);
      // The journey has two published versions: those two are read, nothing more.
      expect(versionReads()).toBe(2);
    }
    getById.mockRestore();
  });

  it("shows a kind only while its own screen is on; catalogs always list, and restore with their switch", async () => {
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_LIFECYCLE_ENABLED", "false");
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
    vi.stubEnv("CATALOG_HISTORY_ENABLED", "false");
    const p = await page();
    expect(p.kinds.map((k) => k.kind)).toEqual(["catalogs"]);
    expect(p.entries.every((e) => e.kind === "catalogs" && !e.canRestore && e.canExport)).toBe(true);
    expect((await page({ kind: "fields" })).entries).toEqual([]);
  });

  it("names an owner off the team only with plans on, and never shows an address kept on an old record", async () => {
    vi.stubEnv("PLANS_ENABLED", "false");
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
    vi.stubEnv("CONNECTORS_ENABLED", "false");
    await forTenant(ctx, w.db).lifecycleVersions.update(`${w.journeyId}_v1`, { publishedBy: "sam@example.com" });
    const { entries } = await page();
    expect(entries.find((e) => e.kind === "journeys" && e.rev === 1)!.by).toBe("A team member");
    expect(JSON.stringify(entries)).not.toContain("sam@example.com");
  });

  it("names a team member with no name set by their sign in address on the page, and never to Vizzy", async () => {
    // Tom is on the team with no display name.
    const list = await readFieldList(ctx, "company", w.db);
    await saveFieldListChange(member, "company", { baseRev: list.rev, change: { op: "add", label: "Pot size", type: "text" }, by: { type: "member", id: "usr_tom" }, nowIso: T(25) }, w.db);
    const onPage = (await page({ kind: "fields" })).entries[0]!;
    expect(line(onPage)).toBe("Company fields v2 · tom@example.com");
    const r = await listHistory(ctx, { kind: "fields" }, { db: w.db, lookup, addresses: false });
    expect(r.ok && r.page.entries[0]!.by).toBe("A team member");
    expect(JSON.stringify(r)).not.toMatch(/@/);
  });

  it("marks the live version when a restore filled the draft, and archived journeys and revoked products read only", async () => {
    await forTenant(ctx, w.db).lifecycleJourneys.update(w.journeyId, { draftRestoredFrom: { version: 1, by: "usr_maya", at: T(9, 12) } });
    let { entries } = await page({ kind: "journeys" });
    expect(entries[0]!.draft).toEqual({ version: 1, by: "Maya Chen", at: T(9, 12) });
    await forTenant(ctx, w.db).lifecycleJourneys.update(w.journeyId, { status: "archived" });
    await forTenant(ctx, w.db).productConnections.update("pcn_life", { status: "revoked" });
    ({ entries } = await page());
    for (const e of entries.filter((x) => x.kind === "journeys" || x.kind === "catalogs")) {
      expect(e).toMatchObject({ canRestore: false, canExport: false });
      expect(e.readOnly).toMatch(/archived_journey|revoked_connection/);
    }
  });

  it("lists what it can when a source can't be read, and says so", async () => {
    // The new index still building: Firestore refuses the ordered query on journey versions.
    const failing = failingFirestore(w.db, { ordered: ["lifecycle_versions"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = await page({}, failing);
    expect(p.partial).toBe(true);
    expect(p.entries.some((e) => e.kind === "journeys")).toBe(false);
    expect(p.entries.length).toBeGreaterThan(0);
    warn.mockRestore();
  });
});

describe("listHistory: team views", () => {
  it("lists every team save while views are on, one view a version, and never anyone's own views", async () => {
    await addTeamViews(w);
    // Off: the kind isn't listed, and nothing of the views shows.
    expect((await page()).kinds.map((k) => k.kind)).not.toContain("views");
    expect((await page({ kind: "views" })).entries).toEqual([]);
    expect((await page({ subject: "views:person" })).entries).toEqual([]);
    viewsOn();
    const p = await page();
    expect(p.kinds.map((k) => k.label)).toEqual(["Fields", "Journeys", "Product catalogs", "Shared connections", "Team views"]);
    expect((await page({ kind: "views" })).entries.map(line)).toEqual(["Team views v4 · Maya Chen", "Team views v3 · Maya Chen", "Team views v2 · Maya Chen", "Team views v1 · Maya Chen"]);
    expect(p.entries[0]).toMatchObject({ kind: "views", subject: "views:person", rev: 4, message: "Archived team view ‘Gold tier’", items: ["Archived ‘Gold tier’"], canRestore: true, canExport: true, readOnly: null, archivedKeys: [] });
    expect(p.entries.find((e) => e.kind === "views" && e.rev === 2)).toMatchObject({ message: "Renamed ‘Wholesale’ to ‘Trade buyers’, a team view", items: ["Changed ‘Trade buyers’"] });
    expect((await page({ subject: "views:person" })).entries.map((e) => e.rev)).toEqual([4, 3, 2, 1]);
    // Tom's own view is in no version: not on the page, nor in what Vizzy reads.
    expect(JSON.stringify(p)).not.toContain("My repots");
    expect(parseHistorySubject("views:person")).toEqual({ kind: "views", store: "settings", subject: "views:person" });
  });

  it("needs fields as well as views, as the People list's views do", async () => {
    await addTeamViews(w);
    viewsOn();
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    expect((await page()).kinds.map((k) => k.kind)).not.toContain("views");
  });
});
