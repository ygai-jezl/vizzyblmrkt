import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { ContentPlanSchema } from "@/lib/types/contentPlan";
import { createNote, getNote } from "./store";
import { backfillNoteUses } from "./backfillUses";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
const KEY = "workspaces/ws1/content_plans";

function plan(db: FakeFirestore, id: string, name: string, checkedAt: string | null, tenantId = "ten_A") {
  const hub = {
    id: "hub",
    type: "hub",
    channel: "blog",
    role: "Hub",
    position: { x: 0, y: 0 },
    brief: "",
    body: "",
    placeholderValues: {},
    status: "generated",
    warnings: [],
    subjectVariants: [],
    ...(checkedAt ? { blog: { checkedAt } } : {}),
  };
  const p = ContentPlanSchema.parse({
    id,
    tenantId,
    workspaceId: "ws1",
    name,
    status: "generating",
    strategy: { objective: "brand_visibility" },
    scope: { topics: [], spark: "" },
    knowledge: {},
    topology: { hubChannel: "blog", spokeChannels: [] },
    graph: { nodes: [hub], edges: [] },
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
  });
  db.seed(KEY, id, p);
}

async function setup(usedBy: string[]) {
  const db = new FakeFirestore();
  const made = await createNote(A, { text: "Daily swings were mostly noise.", kind: "tested", subjectIds: [], canName: false }, { source: "typed" }, { db, embed: async () => [] });
  if (!made.ok) throw new Error("not made");
  await forTenant(A, db).brandNotes.update(made.value.id, { usedBy });
  return { db, id: made.value.id };
}

describe("dating the uses a note had before dates were kept", () => {
  it("dates each from the article's fact check, else its last save, and writes only with apply", async () => {
    const { db, id } = await setup(["ws1/p1", "ws1/p2", "ws1/gone"]);
    plan(db, "p1", "How often to check", "2026-09-12T10:00:00.000Z");
    plan(db, "p2", "Prompt tracking", null);
    const note = (await getNote(A, id, { db }))!;

    expect(await backfillNoteUses(A, note, { apply: false }, { db })).toEqual({ dated: 2, gone: 1 });
    expect((await getNote(A, id, { db }))?.uses).toBeUndefined();

    expect(await backfillNoteUses(A, note, { apply: true }, { db })).toEqual({ dated: 2, gone: 1 });
    expect((await getNote(A, id, { db }))?.uses).toEqual([
      { ref: "ws1/p1", title: "How often to check", at: "2026-09-12T10:00:00.000Z", written: true },
      { ref: "ws1/p2", title: "Prompt tracking", at: "2026-10-01T08:00:00.000Z", written: true },
    ]);
    // Again: nothing left to date, and a dated use is never moved.
    expect(await backfillNoteUses(A, (await getNote(A, id, { db }))!, { apply: true }, { db })).toEqual({ dated: 0, gone: 1 });
  });

  it("keeps uses already dated, and never reads another brand's article", async () => {
    const { db, id } = await setup(["ws1/p1", "ws1/p3"]);
    plan(db, "p1", "How often to check", "2026-09-12T10:00:00.000Z");
    plan(db, "p3", "Theirs", "2026-09-20T10:00:00.000Z", "ten_B");
    await forTenant(A, db).brandNotes.update(id, { uses: [{ ref: "ws1/p1", title: "Kept", at: "2026-09-13T00:00:00.000Z", written: true }] });
    expect(await backfillNoteUses(A, (await getNote(A, id, { db }))!, { apply: true }, { db })).toEqual({ dated: 0, gone: 1 });
    expect((await getNote(A, id, { db }))?.uses).toEqual([{ ref: "ws1/p1", title: "Kept", at: "2026-09-13T00:00:00.000Z", written: true }]);
    expect(await getNote(B, id, { db })).toBeNull();
  });
});
