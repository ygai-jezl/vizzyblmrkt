import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { PERFORMANCE_EXEMPLARS } from "@/lib/tenant/exemplars";
import type { TenantContext } from "@/lib/tenant/types";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import type { EmailLayout } from "@/lib/types/emailLayout";
import {
  APPROVED_EXAMPLES_KEPT,
  examplePieceOf,
  exampleTextOf,
  forgetPlanExamples,
  keepApprovedExample,
  keepApprovedExamples,
} from "./approvedExamples";

const A: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", userId: "usr_1" };
const B: TenantContext = { tenantId: "ten_B", region: "eu", source: "idtoken", userId: "usr_2" };

const emailNode = (over: Partial<ContentNode> = {}) =>
  ({
    id: "email_1",
    type: "email",
    channel: "newsletter",
    status: "approved",
    subject: "Fresh rye on Friday, {{first_name}}",
    body: "Hi {{first_name}},\n\nOur rye is back on Friday. Reserve a loaf at {{hub_url}}.",
    placeholderValues: {},
    ...over,
  }) as ContentNode;

const hubNode = (over: Partial<ContentNode> = {}) =>
  ({
    id: "hub_1",
    type: "hub",
    channel: "newsletter",
    status: "approved",
    body: "# A week at Hearth Bakery\n\nWe kept the rye starter going all week.",
    placeholderValues: {},
    ...over,
  }) as ContentNode;

const embed = () => vi.fn(async (_text: string) => [0.1, 0.2, 0.3]);
const idFor = (tenantId: string, ws: string, plan: string, node: string) => `pex:${tenantId}:approved:${ws}:${plan}:${node}`;
const rows = (db: FakeFirestore) => db.dump(PERFORMANCE_EXEMPLARS);

beforeEach(() => vi.stubEnv("CONTENT_APPROVED_EXAMPLES_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("which pieces become examples", () => {
  it("emails and newsletter or blog hubs; never posts, promos, structural nodes or an eBook", () => {
    expect(examplePieceOf({ type: "email", channel: "newsletter" })).toBe("email");
    expect(examplePieceOf({ type: "hub", channel: "newsletter" })).toBe("hub");
    expect(examplePieceOf({ type: "hub", channel: "blog" })).toBe("hub");
    expect(examplePieceOf({ type: "hub", channel: "ebook" })).toBeNull();
    expect(examplePieceOf({ type: "spoke", channel: "linkedin" })).toBeNull();
    expect(examplePieceOf({ type: "promo_pre", channel: "x" })).toBeNull();
    expect(examplePieceOf({ type: "wait", channel: "standalone" })).toBeNull();
  });
});

describe("the text kept for a piece", () => {
  it("is an email's subject and copy with its merge values left as tags", () => {
    const text = exampleTextOf(emailNode());
    expect(text).toBe("Subject: Fresh rye on Friday, {{first_name}}\n\nHi {{first_name}},\n\nOur rye is back on Friday. Reserve a loaf at {{hub_url}}.");
  });

  it("puts the plan's own link back as {{hub_url}}", () => {
    const node = emailNode({ body: "Reserve a loaf at https://hearth.example.com/rye today.", placeholderValues: { hub_url: "https://hearth.example.com/rye" } });
    expect(exampleTextOf(node)).toContain("Reserve a loaf at {{hub_url}} today.");
    expect(exampleTextOf(node)).not.toContain("hearth.example.com");
  });

  it("reads a laid out email's copy block as plain text, not the rendered email", () => {
    const layout = {
      blocks: [
        { id: "h", kind: "heading", html: "<h1>Hearth Bakery</h1>" },
        { id: "c", kind: "text", role: "copy", html: "<p>Hi {{first_name}},</p><p>The <strong>rye</strong> is back.</p>" },
        { id: "f", kind: "footer" },
      ],
    } as unknown as EmailLayout;
    const text = exampleTextOf(emailNode({ layout, body: "<table><tr><td>rendered email</td></tr></table>" }));
    expect(text).toBe("Subject: Fresh rye on Friday, {{first_name}}\n\nHi {{first_name}},\nThe rye is back.");
  });

  it("is a hub's body as written", () => {
    expect(exampleTextOf(hubNode())).toBe("# A week at Hearth Bakery\n\nWe kept the rye starter going all week.");
  });
});

describe("keeping an approved piece", () => {
  it("stores it in the brand's exemplar store on its writer's channel, scrubbed, with a link back to the piece", async () => {
    const db = new FakeFirestore();
    const e = embed();
    const node = emailNode({ body: "Hi {{first_name}},\n\nWrite to sam@example.com with questions." });
    expect(await keepApprovedExample(A, { workspaceId: "ws1", planId: "plan1", node }, { db, embed: e })).toBe("kept");
    const row = db.raw(PERFORMANCE_EXEMPLARS, idFor("ten_A", "ws1", "plan1", "email_1"));
    expect(row).toMatchObject({
      tenantId: "ten_A",
      channel: "newsletter",
      tags: ["piece:email"],
      metric: { name: "approved", value: 1 },
      sourcePostId: "approved:ws1:plan1:email_1",
      sourceRemoteId: null,
    });
    expect(row?.text).toContain("Hi {{first_name}},");
    expect(row?.text).not.toContain("sam@example.com");
    expect(row?.embedding).toBeDefined();
    expect(e).toHaveBeenCalledOnce();
  });

  it("does nothing with the switch off", async () => {
    vi.stubEnv("CONTENT_APPROVED_EXAMPLES_ENABLED", "");
    const db = new FakeFirestore();
    const e = embed();
    expect(await keepApprovedExample(A, { workspaceId: "ws1", planId: "plan1", node: emailNode() }, { db, embed: e })).toBe("off");
    expect(rows(db)).toEqual([]);
    expect(e).not.toHaveBeenCalled();
  });

  it("never keeps what Vizzy saved, a piece no writer follows, or empty copy", async () => {
    const db = new FakeFirestore();
    const e = embed();
    const agent = { ...A, source: "agent" } as TenantContext;
    expect(await keepApprovedExample(agent, { workspaceId: "ws1", planId: "plan1", node: emailNode() }, { db, embed: e })).toBe("skipped");
    const spoke = { ...hubNode(), type: "spoke", channel: "linkedin" } as ContentNode;
    expect(await keepApprovedExample(A, { workspaceId: "ws1", planId: "plan1", node: spoke }, { db, embed: e })).toBe("skipped");
    expect(await keepApprovedExample(A, { workspaceId: "ws1", planId: "plan1", node: hubNode({ body: "  " }) }, { db, embed: e })).toBe("skipped");
    expect(await keepApprovedExample(A, { workspaceId: "ws/1", planId: "plan1", node: hubNode() }, { db, embed: e })).toBe("skipped");
    expect(rows(db)).toEqual([]);
    expect(e).not.toHaveBeenCalled();
  });

  it("keeps nothing when the embedding fails, as a proven post", async () => {
    const db = new FakeFirestore();
    const r = await keepApprovedExample(A, { workspaceId: "ws1", planId: "plan1", node: hubNode() }, { db, embed: async () => null });
    expect(r).toBe("skipped");
    expect(rows(db)).toEqual([]);
  });

  it("embeds the same copy once, and new copy replaces the piece's example", async () => {
    const db = new FakeFirestore();
    const e = embed();
    const args = { workspaceId: "ws1", planId: "plan1", node: hubNode() };
    expect(await keepApprovedExample(A, args, { db, embed: e })).toBe("kept");
    expect(await keepApprovedExample(A, args, { db, embed: e })).toBe("unchanged");
    expect(e).toHaveBeenCalledOnce();
    expect(await keepApprovedExample(A, { ...args, node: hubNode({ body: "A new week." }) }, { db, embed: e })).toBe("kept");
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]?.text).toBe("A new week.");
  });

  it("keeps the newest for each writer and channel, leaving other pieces, proven posts and other brands alone", async () => {
    const db = new FakeFirestore();
    const old = (i: number) => `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`;
    for (let i = 0; i < APPROVED_EXAMPLES_KEPT; i += 1) {
      db.seed(PERFORMANCE_EXEMPLARS, idFor("ten_A", "ws1", "planOld", `e${i}`), {
        tenantId: "ten_A", channel: "newsletter", text: `old ${i}`, tags: ["piece:email"], metric: { name: "approved", value: 1 }, sourcePostId: `approved:ws1:planOld:e${i}`, createdAt: old(i),
      });
    }
    db.seed(PERFORMANCE_EXEMPLARS, idFor("ten_A", "ws1", "planOld", "hub"), {
      tenantId: "ten_A", channel: "newsletter", text: "a hub", tags: ["piece:hub"], metric: { name: "approved", value: 1 }, sourcePostId: "approved:ws1:planOld:hub", createdAt: old(0),
    });
    db.seed(PERFORMANCE_EXEMPLARS, "pex:ten_A:post:1", {
      tenantId: "ten_A", channel: "newsletter", text: "a proven post", tags: [], metric: { name: "reward_x100", value: 120 }, sourcePostId: "post:1", createdAt: old(0),
    });
    db.seed(PERFORMANCE_EXEMPLARS, idFor("ten_B", "ws9", "plan9", "e0"), {
      tenantId: "ten_B", channel: "newsletter", text: "brand B", tags: ["piece:email"], metric: { name: "approved", value: 1 }, sourcePostId: "approved:ws9:plan9:e0", createdAt: old(0),
    });

    expect(await keepApprovedExample(A, { workspaceId: "ws1", planId: "plan1", node: emailNode() }, { db, embed: embed() })).toBe("kept");
    const emails = rows(db).filter((r) => r.tenantId === "ten_A" && (r.tags as string[]).includes("piece:email"));
    expect(emails).toHaveLength(APPROVED_EXAMPLES_KEPT);
    expect(db.raw(PERFORMANCE_EXEMPLARS, idFor("ten_A", "ws1", "planOld", "e0"))).toBeUndefined();
    expect(db.raw(PERFORMANCE_EXEMPLARS, idFor("ten_A", "ws1", "planOld", "e1"))).toBeDefined();
    expect(db.raw(PERFORMANCE_EXEMPLARS, idFor("ten_A", "ws1", "planOld", "hub"))).toBeDefined();
    expect(db.raw(PERFORMANCE_EXEMPLARS, "pex:ten_A:post:1")).toBeDefined();
    expect(db.raw(PERFORMANCE_EXEMPLARS, idFor("ten_B", "ws9", "plan9", "e0"))).toBeDefined();
  });
});

describe("keeping a save's approvals", () => {
  const plan = (nodes: ContentNode[]) => ({ id: "plan1", workspaceId: "ws1", graph: { nodes, edges: [] } }) as unknown as ContentPlan;

  it("keeps each email and hub this save approved, and nothing already approved or still a draft", async () => {
    const db = new FakeFirestore();
    const before = plan([emailNode({ status: "generated" }), hubNode({ status: "approved" }), emailNode({ id: "email_2", status: "generated" })]);
    const after = plan([emailNode(), hubNode(), emailNode({ id: "email_2", status: "generated" })]);
    expect(await keepApprovedExamples(A, { workspaceId: "ws1", before, after }, { db, embed: embed() })).toBe(1);
    expect(rows(db).map((r) => r.sourcePostId)).toEqual(["approved:ws1:plan1:email_1"]);
  });

  it("never fails the save when a write fails", async () => {
    const write = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const before = plan([hubNode({ status: "generated" })]);
    const n = await keepApprovedExamples(A, { workspaceId: "ws1", before, after: plan([hubNode()]) }, { db: new FakeFirestore(), embed: embed(), write });
    expect(n).toBe(0);
    expect(write).toHaveBeenCalledOnce();
  });
});

describe("deleting a plan", () => {
  it("removes its examples, not another plan's or another brand's", async () => {
    const db = new FakeFirestore();
    await keepApprovedExample(A, { workspaceId: "ws1", planId: "plan1", node: emailNode() }, { db, embed: embed() });
    await keepApprovedExample(A, { workspaceId: "ws1", planId: "plan2", node: hubNode() }, { db, embed: embed() });
    await keepApprovedExample(B, { workspaceId: "ws1", planId: "plan1", node: emailNode() }, { db, embed: embed() });
    vi.stubEnv("CONTENT_APPROVED_EXAMPLES_ENABLED", "");
    const plan1 = { id: "plan1", graph: { nodes: [emailNode(), hubNode({ id: "hub_9" }), { ...hubNode(), id: "s1", type: "spoke", channel: "x" } as ContentNode], edges: [] } };
    expect(await forgetPlanExamples(A, { workspaceId: "ws1", plan: plan1 }, { db })).toBe(2);
    expect(rows(db).map((r) => `${r.tenantId} ${r.sourcePostId}`).sort()).toEqual(["ten_A approved:ws1:plan2:hub_1", "ten_B approved:ws1:plan1:email_1"]);
  });
});
