import { describe, it, expect } from "vitest";
import { buildIntegrationGuide } from "./integrationGuide";
import { SANDBOX_CATALOG } from "./sandbox";
import { ProductMapSchema } from "./productMapSchema";

const connection = {
  keyId: "ygk_acme",
  catalog: SANDBOX_CATALOG,
  contextEndpoint: { url: "https://api.acme.test/ctx", enabled: true, timeoutMs: 5000 },
  webhookEndpoint: null,
  health: { lastEventAt: "2026-09-23T09:00:00Z", lastContextOkAt: "2026-09-23T09:01:00Z", lastContextError: null },
};

describe("integration guide", () => {
  it("lists what to build with the product's own ids", () => {
    const g = buildIntegrationGuide({ connection, origin: "https://yougrow.test" });
    expect(g).toMatchObject({ keyId: "ygk_acme", eventsUrl: "https://yougrow.test/api/v1/events", docsUrl: "https://yougrow.test/developers", fromRepo: false });
    expect(g.status).toEqual({ eventsReceived: "done", contextEndpoint: "done", webhookEndpoint: "info", catalog: "done" });
    const steps = g.events.filter((e) => e.name === "onboarding.step_completed");
    expect(steps.map((e) => e.properties?.step)).toEqual(["create_brand", "run_audit", "monitor_prompts"]);
    expect(steps[1]!.when).toBe("When an audit has finished.");
    expect(g.events.map((e) => e.name)).toEqual(expect.arrayContaining(["user.signed_up", "onboarding.completed", "user.deleted", "email_preferences.updated"]));
    expect(g.context.facts.map((f) => f.id)).toEqual(["share_of_voice", "competitors_named", "engines_checked"]);
    expect(g.identify.traits.map((t) => t.key)).toEqual(["email", "firstName", "timezone", "plan", "company", "jobRole"]);
  });

  it("adds what the repo analysis learned: detection, hooks, exit rules and gaps", () => {
    const map = ProductMapSchema.parse({
      onboardingSteps: [{ id: "run_audit", label: "Run an audit", detection: "server_event" }],
      hooks: [
        { kind: "timezone", description: "Timezone isn't stored at sign-up." },
        { kind: "deletion", description: "Deletion is scheduled 30 days after a request." },
        { kind: "exit_rule", description: "Staff have a `staff` custom claim." },
      ],
      warnings: ["Onboarding progress is computed only in the browser."],
    });
    const g = buildIntegrationGuide({ connection, analysis: { map }, origin: "https://yougrow.test" });
    expect(g.fromRepo).toBe(true);
    expect(g.events.find((e) => e.properties?.step === "run_audit")?.how).toBe("server_event");
    expect(g.events.find((e) => e.name === "user.deleted")?.when).toContain("30 days");
    expect(g.identify.traits.find((t) => t.key === "timezone")?.note).toContain("Timezone isn't stored");
    expect(g.context.exitRules).toEqual(["Staff have a `staff` custom claim."]);
    expect(g.warnings).toEqual(["Onboarding progress is computed only in the browser."]);
  });

  it("marks what's still to do", () => {
    const g = buildIntegrationGuide({
      connection: { ...connection, catalog: { ...SANDBOX_CATALOG, onboardingSteps: [] }, health: {}, contextEndpoint: null },
      origin: "https://yougrow.test",
    });
    expect(g.status).toMatchObject({ eventsReceived: "todo", contextEndpoint: "todo", catalog: "todo" });
  });
});
