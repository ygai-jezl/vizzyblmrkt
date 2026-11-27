import { describe, expect, it } from "vitest";
import type { TenantContext } from "@/lib/tenant/types";
import { MAX_GROUP_NAMES, savedGroupNames } from "./adminApi";
import type { ShownView } from "./savedViews";
import { emptyView } from "./types";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" };
const at = "2026-11-26T10:00:00.000Z";
const view = (id: string, groups: string[]): ShownView => ({
  id,
  scope: "team",
  name: id,
  definition: { ...emptyView(), filters: [{ on: "group", op: "any_of", value: groups }, { on: "can_email", op: "is", value: true }] },
  version: 1,
  archived: false,
  changedAt: at,
  changedBy: "u_admin",
});

describe("the product groups saved views name", () => {
  it("are named once each, from their tag, leaving out any whose name can't be found", async () => {
    const asked: string[] = [];
    const groupName = async (tag: string) => {
      asked.push(tag);
      return tag === "group:con_1:gone" ? null : `Workspace ${tag.split(":").at(-1)}`;
    };
    const named = await savedGroupNames(ctx, [view("viw_000000000001", ["con_1:ws-1", "con_1:gone"]), view("viw_000000000002", ["con_1:ws-1"])], { groupName });
    expect(asked).toEqual(["group:con_1:ws-1", "group:con_1:gone"]);
    expect(named).toEqual([{ id: "con_1:ws-1", label: "Workspace ws-1" }]);
  });

  it("look up at most 10, and a failed look up names nothing", async () => {
    const many = [view("viw_000000000003", Array.from({ length: 15 }, (_, i) => `con_1:ws-${i}`))];
    let n = 0;
    const named = await savedGroupNames(ctx, many, { groupName: async () => (++n === 2 ? Promise.reject(new Error("read failed")) : "A group") });
    expect(n).toBe(MAX_GROUP_NAMES);
    expect(named).toHaveLength(MAX_GROUP_NAMES - 1);
    expect(await savedGroupNames(ctx, [view("viw_000000000004", [])].map((v) => ({ ...v, definition: emptyView() })), { groupName: async () => "x" })).toEqual([]);
  });
});
