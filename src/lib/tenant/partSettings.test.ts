import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { timestampFirestore } from "./testing/timestampFirestore";
import { createOrganisationConnection, changePart, endPart, givePart, partItemKey, repairParts, getOrganisationConnection, type SourceRef } from "./organisationConnections";
import { CONNECTION_PARTS, readSetting, SETTINGS_HOMES, SETTINGS_VERSIONS, settingsDocId } from "./settingsLog";
import { listSettingsVersions } from "@/lib/settings/history";
import type { Region } from "@/lib/types/tenant";
import type { PartSettingItem } from "./organisationConnections";

// Parts in each brand's settings history (Connectors 3, pick 17): giving, changing and taking back
// a part writes the brand's `connections:shared` setting and its version in the brand's own region,
// in the same transaction as the brand record. Fernhill Group [made up] keeps a token in Europe;
// Fernhill US is kept in the United States. Both fakes keep dates as Firestore does (Timestamps).
const ORG = "org_ten_fernhill";
const OCN = "ocn_aaaaaaaaaaaaaaaaaaaa";
const US = { tenantId: "ten_fernhill-us", region: "us" as Region };
const USE = "dcn_uuuuuuuuuuuuuuuuuuuu";
const T0 = "2026-11-24T10:00:00.000Z";
const T1 = "2026-11-24T11:00:00.000Z";
const T2 = "2026-11-24T12:00:00.000Z";
const ZONE_A = "0123456789abcdef0123456789abcd01";
const ZONE_B = "0123456789abcdef0123456789abcd02";
const health = { state: "ok" as const, lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null };

function world() {
  const us = timestampFirestore(new FakeFirestore());
  const eu = timestampFirestore(new FakeFirestore());
  const regionDb = (r: Region) => (r === "eu" ? eu : us);
  return { us, eu, stores: { regionDb } };
}

async function seed(w: ReturnType<typeof world>): Promise<SourceRef> {
  await createOrganisationConnection(
    {
      id: OCN,
      organisationId: ORG,
      region: "eu",
      connectorId: "cloudflare",
      method: "token_fields",
      label: "Cloudflare",
      createdBy: "usr_priya",
      signerUid: null,
      connectedFromTenantId: "ten_fernhill",
      secrets: {},
      health,
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: T0,
      updatedAt: T0,
      disconnectedAt: null,
      collectHold: null,
      parts: [],
    },
    [{ kind: "connected", by: "usr_priya", at: T0 }],
    w.stores,
  );
  return { organisationId: ORG, connectionId: OCN, region: "eu" };
}

const give = (w: ReturnType<typeof world>, source: SourceRef, account = ZONE_A) =>
  givePart(
    {
      source,
      brand: US,
      record: { id: USE, connectorId: "cloudflare", method: "token_fields", label: "Cloudflare", account, ownerUid: "usr_priya", grants: [], secrets: {}, health, pausedAt: null, pausedBy: null, status: "connected", createdAt: T0, updatedAt: T0, disconnectedAt: null },
      recordActivity: [{ kind: "connected", by: "usr_priya", at: T0, code: "part_given" }],
      by: "usr_priya",
      at: T0,
    },
    w.stores,
  );

const ctx = { ...US, source: "system" as const };
const items = async (w: ReturnType<typeof world>) => ((await readSetting<{ items: PartSettingItem[] }>(ctx, "connections:shared", w.us))?.value.items ?? []);

describe("a brand's parts in its settings history", () => {
  it("keeps the setting in the subject's home", () => {
    expect(SETTINGS_HOMES["connections:shared"]).toBe(CONNECTION_PARTS);
  });

  it("records a give as an item and a version, in the brand's region only, by the owner's user id", async () => {
    const w = world();
    expect((await give(w, await seed(w))).ok).toBe(true);
    expect(await items(w)).toEqual([
      expect.objectContaining({ key: partItemKey(USE, ZONE_A), label: ZONE_A, archivedAt: null, connectorId: "cloudflare", organisationId: ORG, connectionId: OCN, sourceRegion: "eu", useId: USE, account: ZONE_A, givenBy: "usr_priya", givenAt: T0 }),
    ]);
    const { versions } = await listSettingsVersions(ctx, "connections:shared", {}, w.us);
    expect(versions).toEqual([expect.objectContaining({ rev: 1, source: "editor", by: { type: "member", id: "usr_priya" }, message: "Given by the organisation", items: [expect.objectContaining({ change: "added" })] })]);
    // Nothing of the brand's history goes to the sign in's region.
    expect(w.eu.dump(SETTINGS_VERSIONS)).toHaveLength(0);
    expect(w.eu.dump(CONNECTION_PARTS)).toHaveLength(0);
    expect(JSON.stringify(versions)).not.toContain("secret");
  });

  it("archives the old part with replacedBy on a change, and archives it again on a take back, never removing either", async () => {
    const w = world();
    const source = await seed(w);
    await give(w, source);
    const changed = await changePart(
      {
        source,
        brand: US,
        useId: USE,
        account: ZONE_B,
        by: "usr_priya",
        at: T1,
        plan: () => ({ patch: { account: ZONE_B }, activity: [{ kind: "account_picked", by: "usr_priya", at: T1, code: "part_changed" }] }) as never,
      },
      w.stores,
    );
    expect(changed.ok).toBe(true);
    const after = await items(w);
    expect(after).toEqual([
      expect.objectContaining({ key: partItemKey(USE, ZONE_A), archivedAt: T1, replacedBy: partItemKey(USE, ZONE_B) }),
      expect.objectContaining({ key: partItemKey(USE, ZONE_B), account: ZONE_B, archivedAt: null }),
    ]);
    const ended = await endPart({ source, brand: US, useId: USE, by: "usr_leo", at: T2, code: "stopped_using" }, w.stores);
    expect(ended.ended).toBe(true);
    expect((await items(w)).map((i) => [i.account, i.archivedAt])).toEqual([
      [ZONE_A, T1],
      [ZONE_B, T2],
    ]);
    const { versions } = await listSettingsVersions(ctx, "connections:shared", {}, w.us);
    expect(versions.map((v) => [v.rev, v.message])).toEqual([
      [3, "Stopped using it"],
      [2, "Changed by the organisation"],
      [1, "Given by the organisation"],
    ]);
    expect(versions[0]!.by).toEqual({ type: "member", id: "usr_leo" });
  });

  it("records housekeeping finishing a take back left half done as the system", async () => {
    const w = world();
    const source = await seed(w);
    await give(w, source);
    // Step one of a take back landed, then the server stopped.
    const { changeOrganisationConnection } = await import("./organisationConnections");
    await changeOrganisationConnection(ORG, OCN, "eu", (cur) => ({ patch: { parts: cur.parts.map((p) => ({ ...p, state: "ending" as const, stateSince: T1, endedBy: "system" })) }, activity: [] }), w.stores);
    const rec = (await getOrganisationConnection(ORG, OCN, "eu", w.stores))!;
    expect((await repairParts(rec, { by: "system", now: new Date(T2) }, w.stores)).map((r) => r.outcome)).toEqual(["finished"]);
    const { versions } = await listSettingsVersions(ctx, "connections:shared", {}, w.us);
    expect(versions[0]).toMatchObject({ rev: 2, message: "Ended by housekeeping", by: { type: "system", id: "connectors" } });
  });

  it("undoes step one when the brand's setting belongs to another brand, and writes nothing in the brand's region", async () => {
    const w = world();
    const source = await seed(w);
    w.us.seed(CONNECTION_PARTS, settingsDocId(US.tenantId, "connections:shared"), { tenantId: "ten_someone_else", rev: 0, items: [] });
    await expect(give(w, source)).rejects.toThrow(/belongs to another tenant/);
    expect((await getOrganisationConnection(ORG, OCN, "eu", w.stores))!.parts).toEqual([]);
    expect(w.us.dump("data_connections")).toHaveLength(0);
    expect(w.us.dump(SETTINGS_VERSIONS)).toHaveLength(0);
  });
});
