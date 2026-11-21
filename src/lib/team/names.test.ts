import { describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { FORMER_TEAM_MEMBER, memberLabel, teamMemberNames, type UserLookup } from "./names";

const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", role: "admin", userId: "usr_1" };
const users = [
  { uid: "usr_1", displayName: "Sam Rivera", email: "sam@example.com" },
  { uid: "usr_2", displayName: "  ", email: "priya@example.com" },
  { uid: "usr_3", displayName: "Alex Kim", email: "alex@example.com" },
];
const lookup: UserLookup = async (uids) => users.filter((u) => uids.includes(u.uid));

async function team(db: FakeFirestore, ids: string[], tenantId = "ten_A") {
  for (const id of ids) await forTenant({ ...ctx, tenantId }, db).members.create(`${tenantId}_${id}`, { userId: id, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" });
}

describe("teamMemberNames", () => {
  it("names only the people on this brand's team now", async () => {
    const db = new FakeFirestore();
    await team(db, ["usr_1", "usr_2"]);
    await team(db, ["usr_3"], "ten_B");
    const names = await teamMemberNames(ctx, ["usr_1", "usr_2", "usr_3", "usr_gone", null, undefined, "usr_1"], { db, lookup });
    expect(names).toEqual({ usr_1: "Sam Rivera", usr_2: "priya@example.com" });
    expect(memberLabel("usr_3", names)).toBe(FORMER_TEAM_MEMBER);
    expect(memberLabel("usr_gone", names)).toBe(FORMER_TEAM_MEMBER);
    expect(memberLabel(null, names)).toBe(FORMER_TEAM_MEMBER);
  });

  it("asks nobody when no one is on the team, and never looks up an address", async () => {
    const db = new FakeFirestore();
    const spy = vi.fn(lookup);
    expect(await teamMemberNames(ctx, ["usr_1", "sam@example.com"], { db, lookup: spy })).toEqual({});
    expect(spy).not.toHaveBeenCalled();
    expect(await teamMemberNames(ctx, [], { db, lookup: spy })).toEqual({});
  });

  it("asks about more than 30 ids in chunks", async () => {
    const db = new FakeFirestore();
    const ids = Array.from({ length: 45 }, (_, i) => `usr_${i + 1}`);
    await team(db, ids);
    const spy = vi.fn<UserLookup>(async (uids) => uids.map((uid) => ({ uid, displayName: `Person ${uid}` })));
    const names = await teamMemberNames(ctx, ids, { db, lookup: spy });
    expect(Object.keys(names)).toHaveLength(45);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("shows everyone as a former team member when the lookup fails, and never throws", async () => {
    const db = new FakeFirestore();
    await team(db, ["usr_1"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await teamMemberNames(ctx, ["usr_1"], { db, lookup: async () => Promise.reject(new Error("auth down")) })).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps a member's name to the ids asked about", async () => {
    const db = new FakeFirestore();
    await team(db, ["usr_1"]);
    expect(await teamMemberNames(ctx, ["usr_1"], { db, lookup: async () => users })).toEqual({ usr_1: "Sam Rivera" });
  });
});
