import { describe, expect, it } from "vitest";
import type { ConnectionGrant } from "@/lib/types/dataConnection";
import { can, CONNECTOR_ACTIONS, grantsCode, humanActor, normaliseGrants, type ConnectorAction, type ConnectorActor } from "./grants";

const admin: ConnectorActor = { kind: "human", uid: "usr_admin", role: "admin" };
const member: ConnectorActor = { kind: "human", uid: "usr_member", role: "member" };
const noRole: ConnectorActor = { kind: "human", uid: "usr_x", role: undefined };
const vizzyForAdmin: ConnectorActor = { kind: "agent", agent: "vizzy", forRole: "admin" };
const vizzyForMember: ConnectorActor = { kind: "agent", agent: "vizzy", forRole: "member" };
const reviewJob: ConnectorActor = { kind: "job", job: "article_review" };

const NONE: ConnectionGrant[] = [];
const MEMBERS: ConnectionGrant[] = [{ to: "members", can: "read" }];
const VIZZY: ConnectionGrant[] = [{ to: "agent:vizzy", can: "read" }];
const BOTH: ConnectionGrant[] = [...MEMBERS, ...VIZZY];

/** The whole table: actor, grants, and the actions allowed. Everything not listed is refused. */
const TABLE: Array<[string, ConnectorActor, string, ConnectionGrant[], ConnectorAction[]]> = [
  ["admin", admin, "none", NONE, [...CONNECTOR_ACTIONS]],
  ["admin", admin, "both", BOTH, [...CONNECTOR_ACTIONS]],
  ["member", member, "none", NONE, ["see"]],
  ["member", member, "members", MEMBERS, ["see", "read_live"]],
  ["member", member, "vizzy", VIZZY, ["see"]],
  ["member", member, "both", BOTH, ["see", "read_live"]],
  ["no role", noRole, "none", NONE, ["see"]],
  ["no role", noRole, "members", MEMBERS, ["see", "read_live"]],
  ["vizzy for an admin", vizzyForAdmin, "none", NONE, []],
  ["vizzy for an admin", vizzyForAdmin, "members", MEMBERS, []],
  ["vizzy for an admin", vizzyForAdmin, "vizzy", VIZZY, ["see", "read_live"]],
  ["vizzy for an admin", vizzyForAdmin, "both", BOTH, ["see", "read_live"]],
  ["vizzy for a member", vizzyForMember, "vizzy", VIZZY, ["see"]],
  ["vizzy for a member", vizzyForMember, "both", BOTH, ["see", "read_live"]],
  // A review job keeps what it reads for the team and Vizzy: only a connection both may read.
  ["a review job", reviewJob, "none", NONE, []],
  ["a review job", reviewJob, "members", MEMBERS, []],
  ["a review job", reviewJob, "vizzy", VIZZY, []],
  ["a review job", reviewJob, "both", BOTH, ["see", "read_live"]],
];

describe("the grants table", () => {
  for (const [who, actor, grantsName, grants, allowed] of TABLE) {
    for (const action of CONNECTOR_ACTIONS) {
      const expected = allowed.includes(action);
      it(`${who}, grants ${grantsName}: ${action} is ${expected ? "allowed" : "refused"}`, () => {
        expect(can(actor, action, grants)).toBe(expected);
      });
    }
  }

  it("never lets an agent manage, whatever the grants say", () => {
    for (const action of ["connect", "check", "pause", "resume", "change_grants", "disconnect", "see_details"] as const) {
      expect(can(vizzyForAdmin, action, BOTH)).toBe(false);
    }
  });

  it("takes the role from the server context", () => {
    expect(humanActor({ tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_1", role: "member" })).toEqual({ kind: "human", uid: "usr_1", role: "member" });
  });

  it("stores each known grant once, in a fixed order", () => {
    expect(normaliseGrants([...VIZZY, ...MEMBERS, ...VIZZY])).toEqual(BOTH);
    expect(normaliseGrants([{ to: "members", can: "write" as never }])).toEqual([]);
    expect(grantsCode(BOTH)).toBe("members,agent:vizzy");
    expect(grantsCode([])).toBe("none");
  });
});
