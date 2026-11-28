import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Vizzy's journey canvas and the activate route read and write without an injected database:
// every repository and 0e writer falls back to this test's fake one.
let fake: FakeFirestore;
vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    forTenant: (ctx: Parameters<typeof actual.forTenant>[0], db?: Parameters<typeof actual.forTenant>[1]) => actual.forTenant(ctx, db ?? fake),
    proposeAgentAction: (ctx: Parameters<typeof actual.proposeAgentAction>[0], p: Parameters<typeof actual.proposeAgentAction>[1], opts: { db?: FakeFirestore } = {}) =>
      actual.proposeAgentAction(ctx, p, { db: opts.db ?? fake }),
    transitionAgentAction: (ctx: Parameters<typeof actual.transitionAgentAction>[0], id: string, t: Parameters<typeof actual.transitionAgentAction>[2], opts: { db?: FakeFirestore } = {}) =>
      actual.transitionAgentAction(ctx, id as never, t, { db: opts.db ?? fake }),
  };
});
vi.mock("@/lib/agents/creative", () => ({
  draftCopy: vi.fn(async () => ({ variants: [{ subject: "Welcome aboard", body: "Hi {{first_name}}" }], source: "agent3" })),
}));
vi.mock("@/lib/content/create/activeBrandVoice", () => ({ activeBrandVoiceText: vi.fn(async () => null) }));
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);

import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { AgentAction } from "@/lib/types/agentAction";
import { journeyCanvasKind } from "@/lib/canvas/kinds/journey";
import { publishJourney } from "@/lib/lifecycle/adminApi";
import { waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";
import { CAMPAIGN_ID, ctx as admin, publishWaitlist, seedLaunch } from "@/lib/lifecycle/waitlist/testing/fixtures";

const { POST: activate } = await import("@/app/api/admin/campaigns/[campaignId]/journey/activate/route");

/** What the canvas route hands a kind with LOOPS_ENABLED off: no stamp. */
const LOOPS_OFF = { unstamped: "loops_off" } as const;

/** Vizzy, in a chat with the admin. */
const agent: TenantContext = { ...admin, source: "agent" };
/** Another admin who turns it on. */
const other: TenantContext = { ...admin, userId: "usr_2", email: "other@example.test" };

const graph = (label = "Welcome") => ({
  nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
    { id: "e1", type: "email", position: { x: 0, y: 100 }, data: { label } },
  ],
  edges: [{ id: "a", source: "trigger", target: "e1", sourceHandle: null }],
});

async function records(): Promise<AgentAction[]> {
  return (await forTenant(admin, fake).agentActions.find({ limit: 100 })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.rev - b.rev);
}

beforeEach(() => {
  fake = new FakeFirestore();
  vi.stubEnv("AGENT_RECORD_ENABLED", "true");
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://mk.test");
});
afterEach(() => vi.unstubAllEnvs());

describe("a launch's welcome emails Vizzy drafts, in the store the launch uses", () => {
  it("on the original engine: recorded about the launch, and kept by the admin who turns them on", async () => {
    seedLaunch(fake);
    const r = await journeyCanvasKind.authorDraft({ ctx: agent, input: { scope: { campaignId: CAMPAIGN_ID }, graph: graph() }, made: LOOPS_OFF, brief: "Warm welcome" });
    expect(r).toMatchObject({ ok: true, id: `journey_${CAMPAIGN_ID}` });
    const [open] = await records();
    expect(open).toMatchObject({
      action: "launch_journey.draft",
      state: "proposed",
      draft: { kind: "launch_journey", ref: `journey_${CAMPAIGN_ID}` },
      target: { type: "idea", id: CAMPAIGN_ID },
      requestedBy: { type: "member", id: "usr_1" },
      review: { kind: "agent_draft", href: `/admin/launches/${CAMPAIGN_ID}/journey` },
      proposal: { label: "Fernlight", fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) },
    });
    session.getAdminContext.mockResolvedValue(other);
    const req = new Request(`http://localhost/api/admin/campaigns/${CAMPAIGN_ID}/journey/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "activate" }),
    });
    const res = await activate(req, { params: Promise.resolve({ campaignId: CAMPAIGN_ID }) });
    expect(res.status).toBe(200);
    expect((await records())[0]).toMatchObject({ state: "acted", actedBy: { type: "member", id: "usr_2" }, result: { label: "Fernlight", edited: false }, proposal: null });
  });

  it("on the new engine: recorded on the launch's lifecycle journey, and kept by the admin who publishes it", async () => {
    vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
    seedLaunch(fake, { waitlistEngine: "lifecycle" });
    const { journey } = await publishWaitlist(fake);
    const r = await journeyCanvasKind.authorDraft({ ctx: agent, input: { scope: { campaignId: CAMPAIGN_ID }, graph: graph() }, made: LOOPS_OFF, brief: "Warm welcome" });
    expect(r).toMatchObject({ ok: true, id: waitlistJourneyId(CAMPAIGN_ID) });
    const [open] = await records();
    expect(open).toMatchObject({
      action: "launch_journey.draft",
      state: "proposed",
      draft: { kind: "lifecycle_journey", ref: journey.id },
      target: { type: "idea", id: CAMPAIGN_ID },
      review: { kind: "agent_draft", href: `/admin/lifecycle/${journey.id}` },
      proposal: { label: "Fernlight" },
    });
    const published = await publishJourney(other, journey.id, undefined, fake);
    expect(published.status).toBe(200);
    expect((await records())[0]).toMatchObject({ state: "acted", actedBy: { type: "member", id: "usr_2" }, result: { label: "Fernlight", edited: false } });
  });
});
