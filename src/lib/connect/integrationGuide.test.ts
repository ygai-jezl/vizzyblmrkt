import { describe, it, expect } from "vitest";
import { buildIntegrationGuide } from "./integrationGuide";
import { SANDBOX_CATALOG } from "./sandbox";
import { ProductMapSchema } from "./productMapSchema";
import { EventRequestSchema, UserPatchSchema } from "./v2/contract";

const connection = {
  keyId: "ygk_acme",
  catalog: SANDBOX_CATALOG,
  contextEndpoint: { url: "https://api.acme.test/ctx", enabled: true, timeoutMs: 2000 },
  webhookEndpoint: null,
  health: { lastEventAt: "2026-09-23T09:00:00Z", lastContextOkAt: "2026-09-23T09:01:00Z", lastContextError: null },
};

describe("integration guide", () => {
  it("lists what to send with the product's own ids", () => {
    const g = buildIntegrationGuide({ connection, origin: "https://yougrow.test" });
    expect(g).toMatchObject({ keyId: "ygk_acme", usersUrl: "https://yougrow.test/api/v2/users/{userId}", docsUrl: "https://yougrow.test/developers", fromRepo: false });
    expect(g.status).toEqual({ eventsReceived: "done", contextEndpoint: "done", webhookEndpoint: "info", catalog: "done" });
    expect(g.send.signup.map((f) => f.field)).toEqual(["signedUpAt", "email", "firstName", "timezone", "consent", "traits.plan", "traits.company", "traits.jobRole"]);
    expect(g.send.compliance.map((f) => [f.field, f.example])).toEqual([
      ["subscribed", "false"],
      ["excluded", '{"reason":"staff"}'],
    ]);
    expect(g.send.progress.map((f) => f.field)).toEqual([
      "steps.create_brand",
      "steps.run_audit",
      "steps.monitor_prompts",
      "facts.share_of_voice",
      "facts.competitors_named",
      "facts.engines_checked",
    ]);
    expect(g.send.progress[1]!.when).toBe("When an audit has finished.");
    expect(g.send.deletion).toMatch(/^When an account is erased/);
    expect(g.context.facts.map((f) => f.id)).toEqual(["share_of_voice", "competitors_named", "engines_checked"]);
  });

  it("sends only what API v2 accepts: the fields are the contract's, the examples valid, state never an event", () => {
    const g = buildIntegrationGuide({ connection, origin: "https://yougrow.test" });
    const fields = Object.keys(UserPatchSchema.shape);
    for (const f of [...g.send.signup, ...g.send.compliance, ...g.send.progress]) {
      expect(fields, f.field).toContain(f.field.split(".")[0]);
      if (f.example) expect(UserPatchSchema.safeParse({ [f.field]: JSON.parse(f.example) }).success, f.field).toBe(true);
    }
    // The sandbox catalog lists v1's events; none of them is a v2 milestone, and with steps onboarding.completed isn't needed.
    expect(g.send.milestones).toEqual([]);
    const custom = buildIntegrationGuide({
      connection: {
        ...connection,
        catalog: {
          ...SANDBOX_CATALOG,
          onboardingSteps: [],
          traits: [...SANDBOX_CATALOG.traits, { key: "email", type: "string", label: "Email", description: "" }],
          events: [...SANDBOX_CATALOG.events, { name: "report.exported", label: "Report exported", description: "A report was downloaded." }],
        },
      },
      origin: "https://yougrow.test",
    });
    expect(custom.send.milestones.map((m) => m.event)).toEqual(["onboarding.completed", "report.exported"]);
    for (const m of custom.send.milestones) expect(EventRequestSchema.safeParse({ event: m.event }).success, m.event).toBe(true);
    expect(custom.send.signup.map((f) => f.field)).not.toContain("traits.email"); // identity keys are fields of their own
  });

  it("adds what the repo analysis learned: detection, hooks, exclusions and gaps", () => {
    const map = ProductMapSchema.parse({
      onboardingSteps: [{ id: "run_audit", label: "Run an audit", detection: "server_event" }],
      hooks: [
        { kind: "timezone", description: "Timezone isn't stored at sign-up." },
        { kind: "deletion", description: "Deletion is scheduled 30 days after a request." },
        { kind: "preferences", description: "Opt-outs live in `users.emailOptOut`." },
        { kind: "exit_rule", description: "Staff have a `staff` custom claim." },
      ],
      warnings: ["Onboarding progress is computed only in the browser."],
    });
    const g = buildIntegrationGuide({ connection, analysis: { map }, origin: "https://yougrow.test" });
    expect(g.fromRepo).toBe(true);
    expect(g.send.progress.find((f) => f.field === "steps.run_audit")?.how).toBe("server_event");
    expect(g.send.deletion).toContain("30 days");
    expect(g.send.signup.find((f) => f.field === "timezone")?.when).toContain("Timezone isn't stored");
    expect(g.send.compliance.find((f) => f.field === "subscribed")?.when).toContain("`users.emailOptOut`");
    expect(g.send.compliance.find((f) => f.field === "excluded")?.when).toContain("Staff have a `staff` custom claim.");
    expect(g.exclusions).toEqual(["Staff have a `staff` custom claim."]);
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
