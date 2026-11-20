import { describe, expect, it } from "vitest";
import { proposeAgentAction, transitionAgentAction, type AgentProposal } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { deterministicContactId } from "@/lib/crm/identifiers";
import { agentDedupeKey, type AgentActionId } from "@/lib/types/agentAction";
import { agentActionReviewItem, agentActionReviewItemId, getAgentAction, listAgentActionsForPerson, listOpenAgentActions, pageAgentActions } from "./agentActions";
import type { ContactPersonId } from "./person";

const ctx: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };
const other: TenantContext = { tenantId: "ten_other", region: "us", source: "system" };
const ADA = deterministicContactId("ten_demo", "ada@example.com") as ContactPersonId;
const BO = deterministicContactId("ten_demo", "bo@example.com") as ContactPersonId;
const MEMBER = { type: "member" as const, id: "uid_1" };

function proposal(key: string, over: Partial<AgentProposal> = {}): AgentProposal {
  return {
    dedupeKey: agentDedupeKey("person_fields.suggest", key),
    agent: "vizzy",
    action: "person_fields.suggest",
    target: { type: "person", id: ADA },
    personId: ADA,
    proposal: { fields: { plan: "pro" } },
    basis: null,
    fieldIds: ["plan"],
    signals: [],
    review: { kind: "agent_draft", href: `/admin/crm/people/${ADA}` },
    requestedBy: MEMBER,
    expiresAt: "2026-12-20T10:00:00.000Z",
    at: "2026-11-20T10:00:00.000Z",
    ...over,
  };
}

async function propose(db: FakeFirestore, key: string, over: Partial<AgentProposal> = {}, c: TenantContext = ctx): Promise<AgentActionId> {
  return (await proposeAgentAction(c, proposal(key, over), { db })).action.id;
}

describe("listOpenAgentActions", () => {
  it("lists one action's open suggestions newest first, leaving out decided and expired ones", async () => {
    const db = new FakeFirestore();
    const older = await propose(db, "older", { at: "2026-11-20T09:00:00.000Z" });
    const newer = await propose(db, "newer", { at: "2026-11-20T11:00:00.000Z" });
    const expired = await propose(db, "expired", { at: "2026-11-01T09:00:00.000Z", expiresAt: "2026-11-10T09:00:00.000Z" });
    const declined = await propose(db, "declined");
    await transitionAgentAction(ctx, declined, { to: "declined", reason: "dismissed", by: MEMBER, at: "2026-11-20T12:00:00.000Z" }, { db });
    await propose(db, "fill", { action: "new_person.fill", dedupeKey: agentDedupeKey("new_person.fill", "req_1") });
    await propose(db, "theirs", { target: { type: "person", id: deterministicContactId("ten_other", "ada@example.com") }, personId: deterministicContactId("ten_other", "ada@example.com") as ContactPersonId }, other);

    const open = await listOpenAgentActions(ctx, { action: "person_fields.suggest", now: "2026-11-20T12:00:00.000Z", db });
    expect(open.map((a) => a.id)).toEqual([newer, older]);
    expect(open.map((a) => a.id)).not.toContain(expired);
  });

  it("is not crowded out by another action's backlog", async () => {
    const db = new FakeFirestore();
    for (let i = 0; i < 300; i += 1) {
      db.seed("agent_actions", `aa_other_${String(i).padStart(3, "0")}`, { tenantId: "ten_demo", action: "data_signal.suggest", state: "proposed", createdAt: "2026-11-20T23:00:00.000Z" });
    }
    const mine = await propose(db, "mine");
    const open = await listOpenAgentActions(ctx, { action: "person_fields.suggest", now: "2026-11-20T12:00:00.000Z", limit: 50, db });
    expect(open.map((a) => a.id)).toEqual([mine]);
  });
});

describe("listAgentActionsForPerson", () => {
  it("gives one person's actions in one state, newest first, and says when there may be more", async () => {
    const db = new FakeFirestore();
    const ids: AgentActionId[] = [];
    for (const [k, at] of [["a", "2026-11-20T09:00:00.000Z"], ["b", "2026-11-20T11:00:00.000Z"], ["c", "2026-11-20T10:00:00.000Z"]] as const) ids.push(await propose(db, k, { at }));
    await propose(db, "bo", { target: { type: "person", id: BO }, personId: BO });
    await transitionAgentAction(ctx, ids[2]!, { to: "approved", by: MEMBER, at: "2026-11-20T12:00:00.000Z" }, { db });

    const proposed = await listAgentActionsForPerson(ctx, ADA, { state: "proposed", db });
    expect(proposed.actions.map((a) => a.id)).toEqual([ids[1], ids[0]]);
    expect(proposed.more).toBe(false);
    expect((await listAgentActionsForPerson(ctx, ADA, { state: "approved", db })).actions.map((a) => a.id)).toEqual([ids[2]]);

    const first = await listAgentActionsForPerson(ctx, ADA, { state: "proposed", limit: 1, db });
    expect(first.more).toBe(true);
    const second = await listAgentActionsForPerson(ctx, ADA, { state: "proposed", limit: 1, after: first.last, db });
    expect([...first.actions, ...second.actions].map((a) => a.id).sort()).toEqual([ids[0], ids[1]].sort());
  });
});

describe("pageAgentActions", () => {
  it("pages one action in one state by id", async () => {
    const db = new FakeFirestore();
    const ids = [await propose(db, "a"), await propose(db, "b"), await propose(db, "c")].sort();
    const first = await pageAgentActions(ctx, { action: "person_fields.suggest", state: "proposed" }, { limit: 2, db });
    expect(first.actions.map((a) => a.id)).toEqual(ids.slice(0, 2));
    expect(first.more).toBe(true);
    const second = await pageAgentActions(ctx, { action: "person_fields.suggest", state: "proposed" }, { limit: 2, after: first.last, db });
    expect(second.actions.map((a) => a.id)).toEqual(ids.slice(2));
    expect(second.more).toBe(false);
  });
});

describe("Review items", () => {
  it("turn an open action into an aa: item with its stored kind and link, and nothing once decided or unlinked", async () => {
    const db = new FakeFirestore();
    const id = await propose(db, "r1");
    const action = (await getAgentAction(ctx, id, { db }))!;
    expect(agentActionReviewItemId(id)).toBe(`aa:${id}`);
    expect(agentActionReviewItem(action, { title: "Ada's plan", detail: "Vizzy suggests Pro", action: "Review" })).toEqual({
      id: `aa:${id}`,
      kind: "agent_draft",
      href: `/admin/crm/people/${ADA}`,
      title: "Ada's plan",
      detail: "Vizzy suggests Pro",
      action: "Review",
    });
    expect(agentActionReviewItem({ ...action, state: "acted" }, { title: "t", detail: "d", action: "a" })).toBeNull();
    expect(agentActionReviewItem({ ...action, review: null }, { title: "t", detail: "d", action: "a" })).toBeNull();
    expect(await getAgentAction(other, id, { db })).toBeNull();
  });
});
