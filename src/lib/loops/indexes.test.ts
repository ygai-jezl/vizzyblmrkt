import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addToFleetCells, FLEET_CELLS, fleetCellId } from "@/lib/tenant/fleetCells";
import { laneMarkId, LOOP_LANE, runLaneTransaction, writeLaneMarkTx, writeLoopLane } from "@/lib/tenant/loopLane";
import { addToLoopDay, LOOP_DAYS, loopDayId, loopDayTtlAt, mergeLaneState, mergeLoopDay, runLoopsTransaction, setLoopDayTx, stampKeyFor, writeBrandPointersTx } from "@/lib/tenant/loops";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

/**
 * What the learning loops need from firestore.indexes.json and infra/lifecycle/setup.sh (ADR-0028,
 * section 8 of the plan for steps 4 and 5). Only Firestore itself refuses a query with no index or
 * builds an index entry per map key (the emulator and the fake do neither), so these files are read
 * here: a missing line passes every other test and shows only once deployed.
 */
const ROOT = process.cwd();
const FILE = JSON.parse(readFileSync(join(ROOT, "firestore.indexes.json"), "utf8")) as {
  indexes: Array<{ collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }> }>;
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; indexes: unknown[] }>;
};

/**
 * Fields nobody queries, each exempt from automatic indexing so a map's keys and a stamp's parts are
 * not each an index entry. The four `made` stamps and the two step 5 collections are listed now so
 * one deploy covers both steps.
 */
const EXEMPT = [
  { collection: "loop_days", field: "d", why: "every loop document's data, under the one map (src/lib/tenant/loops.ts)" },
  { collection: "loop_days", field: "ttlAt", why: "the time to live alone reads it" },
  { collection: "fleet_cells", field: "n", why: "step 5's counts across brands, under the one map, read by id (src/lib/tenant/fleetCells.ts)" },
  { collection: "loop_lane", field: "d", why: "the lane's document and the organisation marks, under the one map (src/lib/tenant/loopLane.ts)" },
  { collection: "image_assets", field: "made", why: "each image's stamp (src/lib/admin/brandKit.ts)" },
  { collection: "email_sends", field: "made", why: "step 5's stamp on each send" },
  { collection: "scheduled_posts", field: "made", why: "step 5's stamp on each post" },
  { collection: "agent_actions", field: "made", why: "step 5's stamp on each Vizzy draft" },
  { collection: "image_assets", field: "brandVoteNote", why: "the team's note on a vote, 200 characters of free text (3.11)" },
] as const;

const hearth: TenantContext = { tenantId: "ten_hearth", region: "eu", source: "system" };

describe("the field exemptions the loops need", () => {
  it.each(EXEMPT.map((e) => [`${e.collection}.${e.field}`, e] as const))("%s is exempt from automatic indexing", (_name, e) => {
    const found = FILE.fieldOverrides.filter((o) => o.collectionGroup === e.collection && o.fieldPath === e.field);
    expect(found, `${e.collection}.${e.field} (${e.why}) needs one field exemption in firestore.indexes.json`).toHaveLength(1);
    expect(found[0]!.indexes).toEqual([]);
  });

  it("names no exempt field in a composite index, since nothing queries them", () => {
    const used = FILE.indexes.flatMap((i) => i.fields.filter((f) => EXEMPT.some((e) => e.collection === i.collectionGroup && (f.fieldPath === e.field || f.fieldPath.startsWith(`${e.field}.`)))).map((f) => `${i.collectionGroup}.${f.fieldPath}`));
    expect(used).toEqual([]);
  });

  it("keeps every loop document's data under the exempt map, so no new field slips past the exemption", async () => {
    const db = new FakeFirestore();
    const week = "2026-W48";
    await addToLoopDay(hearth, loopDayId.week(hearth.tenantId, week, 0), { c: { "image_style.natural_photo": { post_image: { v1: { learned: { made: 1 } } } } } }, { ttlAt: loopDayTtlAt("week", week) }, db);
    await mergeLoopDay(hearth, loopDayId.version(hearth.tenantId, "image_style.natural_photo", 1), { throughWeek: week }, db);
    await mergeLaneState(hearth, { foldedThrough: week }, db);
    await stampKeyFor(hearth, () => "k".repeat(32), db);
    await runLoopsTransaction(
      hearth,
      async (txn) => {
        setLoopDayTx(txn, hearth, loopDayId.folded(hearth.tenantId, week), { c: {} }, { ttlAt: loopDayTtlAt("folded", week) }, db);
        writeBrandPointersTx(txn, hearth, { scopes: {} }, db);
      },
      db,
    );
    await writeLoopLane({ cursor: null }, db);
    await runLaneTransaction(async (txn) => writeLaneMarkTx(txn, laneMarkId({ tenantId: hearth.tenantId, organisationId: "org_ten_hearth" }), { week, cells: ["image.s.stamped.free"], outputs: {} }, db), db);
    await addToFleetCells([{ id: fleetCellId.kind("image", week), n: { s: { stamped: { free: 1 } } } }, { id: fleetCellId.orgs(week), n: { p: { free: 1 } } }], db);

    const loopDays = db.dump(LOOP_DAYS);
    expect(loopDays).toHaveLength(6);
    for (const doc of loopDays) expect(Object.keys(doc).filter((k) => !["tenantId", "d", "ttlAt"].includes(k))).toEqual([]);
    expect(db.dump(LOOP_LANE).map((doc) => Object.keys(doc))).toEqual([["d"], ["d"]]);
    expect(db.dump(FLEET_CELLS).map((doc) => Object.keys(doc))).toEqual([["n"], ["n"]]);
  });
});

describe("the indexes the image verdict reads", () => {
  const has = (order: "ASCENDING" | "DESCENDING") =>
    FILE.indexes.some(
      (i) =>
        i.collectionGroup === "image_assets" &&
        i.queryScope === "COLLECTION" &&
        i.fields.map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`).join("|") === `tenantId:ASCENDING|createdAt:${order}`,
    );

  it("reads the window before a look newest first, on the index images already had", () => {
    expect(has("DESCENDING")).toBe(true);
  });

  it("reads the window after a look oldest first, which needs its own index: a composite index serves one sort order", () => {
    expect(has("ASCENDING")).toBe(true);
  });
});

describe("the time to live on loop_days", () => {
  const script = readFileSync(join(ROOT, "infra", "lifecycle", "setup.sh"), "utf8");
  const ttlCase = /^ {2}ttl\)\n([\s\S]*?)^ {4};;$/m.exec(script)?.[1] ?? "";
  const perDatabase = /for db in "\$\{DATABASES\[@\]\}"; do\n([\s\S]*?)\n {4}done/.exec(ttlCase)?.[1] ?? "";

  it("is set in every database the script covers, since each brand's counts live in its own region", () => {
    expect(perDatabase).toMatch(/^ {6}ttl_on "\$db" loop_days ttlAt$/m);
  });

  it("is named in the script's header, which is its help", () => {
    expect(script).toMatch(/^# {3}loop_days\.ttlAt {2,}\S/m);
  });

  it("is the field the store writes on a week's documents", async () => {
    const db = new FakeFirestore();
    const id = loopDayId.week(hearth.tenantId, "2026-W48", 1);
    await addToLoopDay(hearth, id, { t: { image: { made: 1 } } }, { ttlAt: loopDayTtlAt("week", "2026-W48") }, db);
    expect(db.raw(LOOP_DAYS, id)?.ttlAt).toEqual(loopDayTtlAt("week", "2026-W48"));
  });
});
