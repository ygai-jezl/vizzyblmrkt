import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { loopWeekOf } from "@/lib/loops/count";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import { ctx, seedWorld, T0, TENANT_ID } from "@/lib/lifecycle/testing/fixtures";
import type { AgentAction } from "@/lib/types/agentAction";
import { addPasteBatch } from "./apply";
import { dismissPasteBatch, readPaste } from "./batch";
import { DONE_WHEN_TSV } from "./testing/samples";

/**
 * A pasted list under the learning loops (LOOPS_ENABLED, learning loops step 5): the card is made
 * by the code that reads the columns (paste_columns), by Vizzy when it came from the chat and by
 * the paste otherwise. It keeps its stamp, is counted made once as it is saved, and Add counts kept
 * and Dismiss declined against it. With the switch off nothing is stamped or counted.
 */

const card = (db: FakeFirestore) => (db.dump("agent_actions") as unknown as AgentAction[])[0]!;
/** This brand's week under paste_columns: made and answers against the stamp, why none, and made by type. */
function counted(db: FakeFirestore) {
  const week = sumWeek(db, TENANT_ID, loopWeekOf(new Date())) as { c?: Record<string, unknown>; u?: Record<string, unknown>; t?: Record<string, unknown> };
  return { stamped: week.c?.paste_columns, unstamped: week.u?.paste_columns, type: week.t?.agent_action };
}

async function pasted(from: "box" | "chat") {
  const db = new FakeFirestore();
  seedWorld(db);
  const r = await readPaste(ctx, { text: DONE_WHEN_TSV, source: "Our advisers' sheet", from }, { db, nowMs: T0 });
  if (!r.ok || r.outcome !== "ready") throw new Error(JSON.stringify(r));
  return { db, id: r.batch.id, rev: r.batch.rev };
}

afterEach(() => vi.unstubAllEnvs());

describe("a pasted list's card with the learning loops on", () => {
  beforeEach(() => vi.stubEnv("LOOPS_ENABLED", "true"));

  it("from the chat keeps a paste_columns stamp by Vizzy, is counted made once, and Dismiss counts declined", async () => {
    const { db, id, rev } = await pasted("chat");
    expect(card(db).made).toMatchObject({ kind: "paste_columns", scope: "paste_columns", v: 0, arm: "none", by: "vizzy" });
    expect(counted(db)).toEqual({ stamped: { paste_columns: { v0: { none: { made: 1 } } } }, unstamped: undefined, type: { made: 1 } });
    expect(await dismissPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000 })).toBe("dismissed");
    expect(counted(db).stamped).toEqual({ paste_columns: { v0: { none: { made: 1, declined: 1 } } } });
  });

  it("from the People box keeps it by the paste, and Add counts kept once", async () => {
    const { db, id, rev } = await pasted("box");
    expect(card(db).made).toMatchObject({ kind: "paste_columns", by: "paste" });
    const r = await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000 });
    expect(r.ok).toBe(true);
    expect(counted(db).stamped).toEqual({ paste_columns: { v0: { none: { made: 1, kept: 1 } } } });
    // The card is closed: adding it again answers nothing more.
    await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 120_000 });
    expect(counted(db).stamped).toEqual({ paste_columns: { v0: { none: { made: 1, kept: 1 } } } });
  });
});

describe("a pasted list's card with the learning loops off (decision 22)", () => {
  it("keeps no stamp and counts nothing, added or dismissed", async () => {
    const a = await pasted("chat");
    expect(card(a.db)).not.toHaveProperty("made");
    expect(await dismissPasteBatch(ctx, a.id, a.rev, { db: a.db, nowMs: T0 + 60_000 })).toBe("dismissed");
    const b = await pasted("box");
    expect((await addPasteBatch(ctx, b.id, b.rev, { db: b.db, nowMs: T0 + 60_000 })).ok).toBe(true);
    expect([...a.db.dump("loop_days"), ...b.db.dump("loop_days")]).toEqual([]);
  });
});
