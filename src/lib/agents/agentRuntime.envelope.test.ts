import { describe, it, expect } from "vitest";
import type { TenantContext } from "@/lib/tenant/types";
import { contextEnvelope } from "./agentRuntime";
import { shellChatContext } from "@/lib/nav/vizzy";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", userId: "u1", source: "idtoken" };

/** The agent parses `[ctx:{...}]` with a non-greedy `\{.*?\}\]` — mirror that here. */
function parse(envelope: string): Record<string, unknown> {
  const m = /^\s*\[ctx:(\{.*?\})\]\s*/s.exec(envelope);
  if (!m) throw new Error(`no envelope in ${envelope}`);
  return JSON.parse(m[1]!) as Record<string, unknown>;
}

describe("contextEnvelope page context", () => {
  it("carries the page the admin is on", () => {
    const env = contextEnvelope(ctx, "t1", "fast", { page: "Launches › Fernlight Beta › Signups", campaignId: "c1" });
    expect(parse(env)).toMatchObject({ page: "Launches › Fernlight Beta › Signups", campaignId: "c1", tenantId: "ten_A" });
    expect(env).toContain("[mode:fast]");
  });

  it("leaves page out when there is none", () => {
    expect(parse(contextEnvelope(ctx, "t1", undefined, { page: null }))).not.toHaveProperty("page");
  });

  it("carries the programme and plan in view (nav v2 phase 4)", () => {
    const env = contextEnvelope(ctx, "t1", undefined, { workspaceId: "ws1", planId: "8e1ad6e8-afb0-4f3b-bb62-5102b5bcd7b2" });
    expect(parse(env)).toMatchObject({ workspaceId: "ws1", planId: "8e1ad6e8-afb0-4f3b-bb62-5102b5bcd7b2" });
    expect(parse(contextEnvelope(ctx, "t1"))).not.toHaveProperty("workspaceId");
  });
});


describe("contextEnvelope journey in view (journey styles)", () => {
  it("carries a journey, keeps an empty one (it clears the last), and leaves out none", () => {
    expect(parse(contextEnvelope(ctx, "t1", undefined, { connectionId: "pcn_1", journeyId: "lcj_1" }))).toMatchObject({
      connectionId: "pcn_1",
      journeyId: "lcj_1",
    });
    expect(parse(contextEnvelope(ctx, "t1", undefined, { journeyId: "" }))).toHaveProperty("journeyId", "");
    expect(parse(contextEnvelope(ctx, "t1", undefined, { journeyId: null }))).not.toHaveProperty("journeyId");
    expect(parse(contextEnvelope(ctx, "t1"))).not.toHaveProperty("journeyId");
    // The launch the same way.
    expect(parse(contextEnvelope(ctx, "t1", undefined, { campaignId: "" }))).toHaveProperty("campaignId", "");
    expect(parse(contextEnvelope(ctx, "t1", undefined, { campaignId: null }))).not.toHaveProperty("campaignId");
  });

  it("the Ask Vizzy panel moving from a journey page to a launch page stops naming the journey", () => {
    const opts = { phase4: false, journeyInContext: true };
    const onJourney = parse(contextEnvelope(ctx, "t1", undefined, shellChatContext("/admin/lifecycle/lcj_a", "Journeys › A", opts)));
    const onLaunch = parse(contextEnvelope(ctx, "t2", undefined, shellChatContext("/admin/launches/cmp_b", "Launches › B", opts)));
    expect(onJourney).toMatchObject({ journeyId: "lcj_a", campaignId: "" });
    // Agent-side, "" replaces lcj_a in the session, so the launch's welcome journey is the one in view.
    expect(onLaunch).toMatchObject({ campaignId: "cmp_b", journeyId: "" });
    // Flag off: exactly as before, no journey key at all.
    const off = parse(contextEnvelope(ctx, "t3", undefined, shellChatContext("/admin/lifecycle/lcj_a", "Journeys › A", { phase4: false })));
    expect(off).not.toHaveProperty("journeyId");
    expect(off).not.toHaveProperty("campaignId");
  });

  it("the Ask Vizzy panel moving from a launch page to Home stops naming the launch", () => {
    const opts = { phase4: false, journeyInContext: true };
    const onLaunch = parse(contextEnvelope(ctx, "t1", undefined, shellChatContext("/admin/launches/cmp_b/settings", "Launches › B", opts)));
    const onHome = parse(contextEnvelope(ctx, "t2", undefined, shellChatContext("/admin", "Home", opts)));
    expect(onLaunch).toMatchObject({ campaignId: "cmp_b", journeyId: "" });
    // Agent-side, "" replaces cmp_b too, so "this journey" on Home is no journey, not B's welcome journey.
    expect(onHome).toMatchObject({ campaignId: "", journeyId: "" });
    // Flag off: exactly as before, no launch key off a launch page.
    expect(parse(contextEnvelope(ctx, "t3", undefined, shellChatContext("/admin", "Home", { phase4: false })))).not.toHaveProperty(
      "campaignId",
    );
  });

  it("names the person in view by our id, and clears them off their page", () => {
    const opts = { phase4: false, personInContext: true };
    const onPerson = parse(contextEnvelope(ctx, "t1", undefined, shellChatContext("/admin/crm/people/pu_3f9a", "Audience › Product users › Person", opts)));
    expect(onPerson).toMatchObject({ personId: "pu_3f9a", page: "Audience › Product users › Person" });
    expect(parse(contextEnvelope(ctx, "t2", undefined, shellChatContext("/admin/crm", "Audience", opts)))).toMatchObject({ personId: "" });
    // Not sent at all while Vizzy can't read a person.
    expect(parse(contextEnvelope(ctx, "t3", undefined, shellChatContext("/admin/crm/people/pu_3f9a", "Page", { phase4: false })))).not.toHaveProperty("personId");
    expect(parse(contextEnvelope(ctx, "t4", undefined, { personId: null }))).not.toHaveProperty("personId");
  });
});
