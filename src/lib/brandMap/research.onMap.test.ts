import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { ensureMoved } from "./move";
import { createSubject } from "./records";
import { subjectsOnMap } from "./research";

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the subjects research is told about, on a map at any size", () => {
  it("lists every subject of a small map, and reads a count that fails as a big one", async () => {
    const c = { tenantId: "ten_acme", region: "us", source: "idtoken", userId: "u1", role: "admin" } as const;
    const db = new FakeFirestore();
    await ensureMoved(c, { db });
    for (const name of ["Share of voice", "Citations"]) await createSubject(c, { name }, { db });
    const identity = { name: "Acme", category: "AI visibility tracking", statement: "Acme tracks share of voice in AI answers." };
    // No meaning to be had: the nearest come from shared words.
    const embed = { embed: async () => [], query: async () => null };
    expect(await subjectsOnMap(c, identity, { db, embed })).toEqual({ total: 2, known: expect.arrayContaining(["Share of voice", "Citations"]) });

    // Counts fail (an index not ready): never every subject, only the nearest.
    const failing = failingFirestore(db, { counts: true });
    expect(await subjectsOnMap(c, identity, { db: failing, embed })).toEqual({ total: 1, known: ["Share of voice"] });
  });
});
