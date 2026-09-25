import { describe, it, expect } from "vitest";
import { setupSteps, type SetupInput } from "./setupChecklist";

const base: SetupInput = {
  kind: "custom",
  environment: null,
  guide: { catalog: "todo", eventsReceived: "todo", contextEndpoint: "todo" },
  journeys: [],
  production: null,
};
const summary = (input: SetupInput) => setupSteps(input).map((s) => `${s.id}:${s.done ? "done" : "todo"}`);

describe("setupSteps", () => {
  it("lists the work in order, starting after the keys", () => {
    expect(summary(base)).toEqual(["connect:done", "catalog:todo", "events:todo", "context:todo", "journey:todo", "live:todo"]);
  });

  it("follows the guide and the journeys", () => {
    const input: SetupInput = {
      ...base,
      guide: { catalog: "done", eventsReceived: "done", contextEndpoint: "done" },
      journeys: [{ status: "active", deliveryMode: "live", publishedVersion: 2 }],
    };
    expect(setupSteps(input).every((s) => s.done)).toBe(true);
    const testOnly = { ...input, journeys: [{ status: "active", deliveryMode: "test", publishedVersion: 2 }] };
    expect(summary(testOnly).at(-1)).toBe("live:todo");
  });

  it("staging ends with promoting to production", () => {
    const staging: SetupInput = { ...base, environment: "staging" };
    expect(setupSteps(staging).at(-1)).toMatchObject({ id: "promote", done: false, href: "/admin/products" });
    const withProd = { ...staging, production: { id: "prd", hasJourney: true } };
    expect(setupSteps(withProd).at(-1)).toMatchObject({ id: "promote", done: true, href: "/admin/lifecycle" });
  });

  it("points custom products at the repo and the developer guide, sandboxes at their own tabs", () => {
    const custom = setupSteps(base);
    expect(custom.find((s) => s.id === "catalog")?.tab).toBe("learn");
    expect(custom.find((s) => s.id === "events")?.tab).toBe("guide");
    const sandbox = setupSteps({ ...base, kind: "sandbox" });
    expect(sandbox.find((s) => s.id === "catalog")?.tab).toBe("catalog");
    expect(sandbox.find((s) => s.id === "events")?.tab).toBe("events");
  });

  it("ends with inviting the waitlist on production when invites are on", () => {
    const base = {
      kind: "custom" as const,
      environment: "production" as const,
      guide: { catalog: "done" as const, eventsReceived: "done" as const, contextEndpoint: "done" as const },
      journeys: [],
      production: null,
    };
    expect(setupSteps(base).map((s) => s.id)).not.toContain("invite");
    const noLink = setupSteps({ ...base, invites: { hasSignupUrl: false, invited: 0, signedUp: 0 } }).at(-1);
    expect(noLink).toMatchObject({ id: "invite", done: false, tab: "settings" });
    const sent = setupSteps({ ...base, invites: { hasSignupUrl: true, invited: 300, signedUp: 212 } }).at(-1);
    expect(sent).toMatchObject({ id: "invite", done: true, href: "/admin/launches", detail: "300 invited · 212 signed up." });
    expect(setupSteps({ ...base, environment: "staging", invites: { hasSignupUrl: true, invited: 0, signedUp: 0 } }).map((s) => s.id)).not.toContain("invite");
  });
});


describe("optional steps", () => {
  it("marks the context endpoint optional, so setup can complete without it", () => {
    const steps = setupSteps({
      kind: "custom",
      environment: "production",
      guide: { catalog: "done", eventsReceived: "done", contextEndpoint: "todo" },
      journeys: [],
      production: null,
    } as never);
    expect(steps.find((s) => s.id === "context")).toMatchObject({ optional: true, done: false });
    expect(steps.filter((s) => s.optional).map((s) => s.id)).toEqual(["context"]);
  });
});
