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
});
