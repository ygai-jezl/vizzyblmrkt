import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { brandMapDocId } from "@/lib/types/brandMap";
import { afterRecordsChange } from "./afterChange";
import { ensureMoved } from "./move";
import { decideProposals } from "./proposals";
import { createGroup, createSubject, listGroups, listSubjects } from "./records";
import { parseGroupLines, sortIntoGroups } from "./sortGroups";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

/** The model's answer, by subject name: it reads the numbers the prompt gave them. */
const answerFor = (groups: Record<string, string[]>) =>
  vi.fn(async (prompt: string) => {
    const numbered = new Map([...prompt.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => [m[2]!, Number(m[1])]));
    return Object.entries(groups)
      .map(([group, names]) => `GROUP: ${group} | ${names.flatMap((n) => (numbered.has(n) ? [numbered.get(n)] : [])).join(", ")}`)
      .join("\n");
  });

const SORTED = { Tracking: ["Share of voice", "Prompt tracking"], "Getting cited": ["Citation gaps", "AI Overviews"], Lonely: ["Pricing"] };

async function setup() {
  const db = new FakeFirestore();
  await ensureMoved(ctx, { db, nowMs: NOW });
  const g = await createGroup(ctx, { name: "Tracking" }, { db, nowMs: NOW });
  for (const name of ["Share of voice", "Citation gaps", "AI Overviews", "Prompt tracking", "Pricing"]) await createSubject(ctx, { name }, { db, nowMs: NOW });
  return { db, tracking: g.ok ? g.value.id : "" };
}

describe("reading the model's groups", () => {
  it("takes each subject once, by its number, and drops a line with an address or no subjects", () => {
    const text = ["GROUP: Tracking | 1, 2, 3", "- GROUP: **Getting cited** | 3, 4", "GROUP: See https://x.example/a | 5", "GROUP: Empty | 99", "Something else"].join("\n");
    expect(parseGroupLines(text, 5)).toEqual([
      { name: "Tracking", members: [1, 2, 3] },
      { name: "Getting cited", members: [4] },
    ]);
  });
});

describe("sorting subjects into groups", () => {
  it("suggests a group the map has, proposes a new one for two or more subjects, and moves nothing", async () => {
    const { db } = await setup();
    const generate = answerFor(SORTED);
    const r = await sortIntoGroups(ctx, { cursor: null }, { db, nowMs: NOW, generate, modelReady: () => true });
    expect(r).toMatchObject({ ok: true, done: true, next: null, suggested: 4, proposedGroups: ["Getting cited"] });
    expect(generate.mock.calls[0]![0]).toContain("- Tracking");
    expect((await listGroups(ctx, { db })).map((g) => [g.name, g.status, g.suggested])).toEqual([
      ["Tracking", "decided", 2],
      ["Getting cited", "proposed", 2],
    ]);
    // Nothing has moved: every subject is still in no group.
    expect(await listSubjects(ctx, { groupId: null }, { db })).toHaveLength(5);

    // Sorting again asks only about the subjects with no suggestion yet.
    const again = vi.fn(async (_prompt: string) => "");
    await sortIntoGroups(ctx, { cursor: null }, { db, nowMs: NOW, generate: again, modelReady: () => true });
    expect(again.mock.calls[0]![0]).toContain("Pricing");
    expect(again.mock.calls[0]![0]).not.toContain("Share of voice");
  });

  it("moves the suggested subjects in when a person adds the group, and lets them go when they dismiss", async () => {
    const { db, tracking } = await setup();
    await sortIntoGroups(ctx, { cursor: null }, { db, nowMs: NOW, generate: answerFor(SORTED), modelReady: () => true });
    const cited = (await listGroups(ctx, { db })).find((g) => g.name === "Getting cited")!;

    const r = await decideProposals(ctx, { accept: { groups: [cited.id] } }, { db, nowMs: NOW });
    // Moving changes no subject's counts or meaning: only the two groups' totals are worked out again.
    expect(r).toMatchObject({ accepted: 3, touched: [], groups: [cited.id, null] });
    await afterRecordsChange(ctx, { subjects: r.touched, groups: r.groups }, { db, nowMs: NOW });
    expect((await listSubjects(ctx, { groupId: cited.id }, { db })).map((s) => s.name).sort()).toEqual(["AI Overviews", "Citation gaps"]);
    expect(await brandMapRecords(ctx, db).get("grp", cited.id)).toMatchObject({ status: "decided", suggested: 0, totals: { subjects: 2 } });
    expect(db.raw("brand_maps", brandMapDocId("ten_A"))?.ungroupedTotals).toMatchObject({ subjects: 3 });

    // A decided group stays decided: only the suggestions for it go.
    await decideProposals(ctx, { dismiss: { groups: [tracking] } }, { db, nowMs: NOW });
    expect(await brandMapRecords(ctx, db).get("grp", tracking)).toMatchObject({ status: "decided", suggested: 0 });
    expect(await listSubjects(ctx, { suggestedGroupId: tracking }, { db })).toHaveLength(0);
  });

  it("never proposes again a group a person dismissed", async () => {
    const { db } = await setup();
    await sortIntoGroups(ctx, { cursor: null }, { db, nowMs: NOW, generate: answerFor(SORTED), modelReady: () => true });
    const cited = (await listGroups(ctx, { db })).find((g) => g.name === "Getting cited")!;
    await decideProposals(ctx, { dismiss: { groups: [cited.id] } }, { db, nowMs: NOW });
    const r = await sortIntoGroups(ctx, { cursor: null }, { db, nowMs: NOW, generate: answerFor(SORTED), modelReady: () => true });
    expect(r).toMatchObject({ ok: true, proposedGroups: [] });
    expect((await listGroups(ctx, { db })).map((g) => g.name)).toEqual(["Tracking"]);
  });

  it("says when there's no model, and when the model doesn't answer", async () => {
    const { db } = await setup();
    expect(await sortIntoGroups(ctx, { cursor: null }, { db, modelReady: () => false })).toEqual({ ok: false, status: 503, error: "no_model" });
    expect(await sortIntoGroups(ctx, { cursor: null }, { db, generate: async () => null, modelReady: () => true })).toEqual({ ok: false, status: 502, error: "research_failed" });
  });
});
