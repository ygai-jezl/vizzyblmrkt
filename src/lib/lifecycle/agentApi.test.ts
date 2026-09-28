import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { agentLifecycleContext, agentLifecycleJourney } from "./agentApi";
import { CONNECTION_ID, TENANT_ID, publishOnboarding, seedUser, seedWorld } from "./testing/fixtures";

/**
 * What Lifecycle Ops reads, pinned whole. Journey styles will add a `journeyStyle` key to the
 * context (only with EMAIL_JOURNEY_STYLE_ENABLED on) and an `emailStyle` to a draft's settings
 * (only once one is set). With neither, both answers must stay exactly this.
 */

const agent: TenantContext = { tenantId: TENANT_ID, region: "eu", userId: "usr_1", role: "admin", source: "agent" };

beforeEach(() => {
  vi.stubEnv("LIFECYCLE_ENABLED", "true");
  vi.stubEnv("LIFECYCLE_CHAT_AUTHORING_ENABLED", "true");
  vi.stubEnv("EMAIL_STYLE_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

async function world() {
  const db = new FakeFirestore();
  seedWorld(db);
  seedUser(db, "alex", { steps: { create_brand: { doneAt: "2026-09-21T09:00:00.000Z" } } });
  seedUser(db, "bea");
  const { journey } = await publishOnboarding(db);
  return { db, journey };
}

describe("Lifecycle Ops' context, as read today", () => {
  it("pins the whole answer, with the Email style flag off", async () => {
    const { db, journey } = await world();
    const r = await agentLifecycleContext(agent, db);
    expect(r.status).toBe(200);
    expect(JSON.parse(JSON.stringify(r.body).replaceAll(journey.id, "<journeyId>"))).toMatchInlineSnapshot(`
      {
        "connections": [
          {
            "catalog": {
              "entityKinds": [],
              "events": [],
              "facts": [],
              "glossary": [],
              "onboardingSteps": [
                {
                  "completion": "",
                  "id": "create_brand",
                  "kind": null,
                  "label": "Add your brand",
                  "url": "https://app.example.com/brand",
                },
                {
                  "completion": "",
                  "id": "run_audit",
                  "kind": null,
                  "label": "Run an audit",
                  "url": "https://app.example.com/audits?new=1",
                },
                {
                  "completion": "",
                  "id": "monitor_prompts",
                  "kind": null,
                  "label": "Monitor prompts",
                  "url": "https://app.example.com/prompts",
                },
              ],
              "traits": [
                {
                  "description": "",
                  "key": "plan",
                  "label": "Plan",
                  "type": "string",
                },
              ],
            },
            "contextConfigured": true,
            "id": "pcn_life",
            "kind": "custom",
            "name": "Sandbox",
            "stats": {
              "sampled": false,
              "steps": [
                {
                  "completedShare": 0.5,
                  "id": "create_brand",
                  "label": "Add your brand",
                  "medianHoursToComplete": 2,
                },
                {
                  "completedShare": 0,
                  "id": "run_audit",
                  "label": "Run an audit",
                  "medianHoursToComplete": null,
                },
                {
                  "completedShare": 0,
                  "id": "monitor_prompts",
                  "label": "Monitor prompts",
                  "medianHoursToComplete": null,
                },
              ],
              "users": 2,
            },
            "status": "active",
          },
        ],
        "journeys": [
          {
            "authoredBy": "human",
            "connectionId": "pcn_life",
            "deliveryMode": "test",
            "id": "<journeyId>",
            "name": "Onboarding",
            "publishedVersion": 1,
            "status": "active",
            "updatedAt": "2026-09-21T06:00:00.000Z",
          },
        ],
        "senderName": "Jez at Sandbox",
        "verifiedSendingDomains": [
          "sandbox.test",
        ],
        "workspaces": [],
      }
    `);
  });

  it("with the Email style flag on, adds only whether a style is saved", async () => {
    const { db } = await world();
    const off = (await agentLifecycleContext(agent, db)).body as Record<string, unknown>;
    vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
    expect((await agentLifecycleContext(agent, db)).body).toEqual({ ...off, emailStyle: { configured: false } });
    db.seed("tenants", TENANT_ID, {
      ...db.raw("tenants", TENANT_ID),
      emailStyle: { logo: null, companyName: null, headerColor: "#0b1f3a", accentColor: "#ff6b35" },
    });
    expect((await agentLifecycleContext(agent, db)).body).toEqual({ ...off, emailStyle: { configured: true } });
  });
});

describe("Lifecycle Ops' journey read, as today", () => {
  it("pins the whole answer: the journey, its draft as stored, its issues and its product", async () => {
    const { db, journey } = await world();
    const r = await agentLifecycleJourney(agent, journey.id, db);
    expect(r).toEqual({
      status: 200,
      body: {
        journey: {
          id: journey.id,
          name: "Onboarding",
          connectionId: CONNECTION_ID,
          status: "active",
          deliveryMode: "test",
          publishedVersion: 1,
          authoredBy: "human",
          draft: journey.draft,
        },
        issues: [],
        connection: {
          id: CONNECTION_ID,
          name: "Sandbox",
          onboardingSteps: [
            { id: "create_brand", label: "Add your brand" },
            { id: "run_audit", label: "Run an audit" },
            { id: "monitor_prompts", label: "Monitor prompts" },
          ],
        },
      },
    });
    const { draft } = (r.body as { journey: { draft: typeof journey.draft } }).journey;
    expect(Object.keys(draft)).toEqual(["graph", "pools", "settings"]);
    expect(Object.keys(draft.settings).sort()).toMatchInlineSnapshot(`
      [
        "about",
        "category",
        "entry",
        "sendPolicy",
        "sender",
        "tracking",
        "trigger",
      ]
    `);
  });

  it("a journey that isn't there is 404", async () => {
    const { db } = await world();
    expect(await agentLifecycleJourney(agent, "lcj_missing", db)).toEqual({ status: 404, body: { error: "not_found" } });
  });
});
