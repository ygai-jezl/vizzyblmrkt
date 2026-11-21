import { describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { CatalogRevision } from "@/lib/types/catalogRevision";
import { cachedResolver, isSaverAddress, scrubCatalogSavers, type ResolveSaver } from "./catalogSavers";

const A: TenantContext = { tenantId: "ten_A", region: "eu", source: "system" };
const B: TenantContext = { tenantId: "ten_B", region: "eu", source: "system" };
const KNOWN: Record<string, string> = { "sam@example.com": "usr_sam" };
const resolve: ResolveSaver = async (email) => KNOWN[email] ?? null;

async function version(ctx: TenantContext, db: FakeFirestore, rev: number, savedBy: string | null) {
  const row: Omit<CatalogRevision, "id" | "tenantId"> = {
    connectionId: "pcn_app",
    rev,
    catalog: {} as CatalogRevision["catalog"],
    savedAt: "2026-11-01T00:00:00.000Z",
    savedBy,
    source: "editor",
    changes: [],
  };
  await forTenant(ctx, db).catalogRevisions.create(`pcn_app_${ctx.tenantId}_r${String(rev).padStart(6, "0")}`, row);
}

const savers = async (ctx: TenantContext, db: FakeFirestore) =>
  (await forTenant(ctx, db).catalogRevisions.find({})).sort((a, b) => a.rev - b.rev).map((r) => r.savedBy);

describe("scrubbing catalog savers' addresses", () => {
  it("tells an address from a user id", () => {
    expect(isSaverAddress("sam@example.com")).toBe(true);
    expect(isSaverAddress("usr_sam")).toBe(false);
    expect(isSaverAddress(null)).toBe(false);
  });

  it("counts in a dry run and writes nothing", async () => {
    const db = new FakeFirestore();
    await version(A, db, 1, "sam@example.com");
    await version(A, db, 2, "gone@example.com");
    await version(A, db, 3, "usr_sam");
    await version(A, db, 4, null);
    const counts = await scrubCatalogSavers(A, { resolve, dryRun: true, db });
    expect(counts).toEqual({ scanned: 4, replaced: 1, cleared: 1, already: 2, gone: 0 });
    expect(await savers(A, db)).toEqual(["sam@example.com", "gone@example.com", "usr_sam", null]);
  });

  it("replaces each address with the user id, or null, in this brand only, and is safe to run again", async () => {
    const db = new FakeFirestore();
    await version(A, db, 1, "Sam@Example.com");
    await version(A, db, 2, "gone@example.com");
    await version(B, db, 1, "sam@example.com");
    expect(await scrubCatalogSavers(A, { resolve, dryRun: false, db })).toMatchObject({ replaced: 1, cleared: 1 });
    expect(await savers(A, db)).toEqual(["usr_sam", null]);
    expect(await savers(B, db)).toEqual(["sam@example.com"]);
    expect(await scrubCatalogSavers(A, { resolve, dryRun: false, db })).toEqual({ scanned: 2, replaced: 0, cleared: 0, already: 2, gone: 0 });
  });

  it("pages through more versions than one page", async () => {
    const db = new FakeFirestore();
    for (let rev = 1; rev <= 650; rev += 1) await version(A, db, rev, "sam@example.com");
    const spy = vi.fn(resolve);
    const counts = await scrubCatalogSavers(A, { resolve: spy, dryRun: false, db });
    expect(counts).toMatchObject({ scanned: 650, replaced: 650 });
    // One lookup per address, however many versions name it.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new Set(await savers(A, db))).toEqual(new Set(["usr_sam"]));
  });

  it("asks once per address, whatever its case", async () => {
    const spy = vi.fn(resolve);
    const r = cachedResolver(spy);
    expect(await r("Sam@Example.com")).toBe("usr_sam");
    expect(await r("sam@example.com ")).toBe("usr_sam");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("sam@example.com");
  });
});
