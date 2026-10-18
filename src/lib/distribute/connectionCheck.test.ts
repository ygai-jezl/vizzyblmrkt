import { describe, expect, it } from "vitest";
import { connectionProblem } from "./connectionCheck";

const conn = { enc: { ct: "c", iv: "i", tag: "t" }, connectedAt: "2026-10-16T00:00:00.000Z" };
const PAGE = "urn:li:organization:123";

describe("connectionProblem", () => {
  it("X needs an X connection", () => {
    expect(connectionProblem(null, "x")).toBe("x_not_connected");
    expect(connectionProblem({ socialConnections: { x: { ...conn, platform: "x" } } }, "x")).toBeNull();
  });

  it("LinkedIn posts as the member, else the first Page", () => {
    expect(connectionProblem({ socialConnections: {} }, "linkedin")).toBe("linkedin_not_connected");
    expect(connectionProblem({ socialConnections: { linkedin: { ...conn, platform: "linkedin", userId: "m1" } } }, "linkedin")).toBeNull();
    const pages = { linkedin_org: { ...conn, platform: "linkedin_org" as const, orgs: [{ urn: PAGE, name: "Acme" }] } };
    expect(connectionProblem({ socialConnections: pages }, "linkedin")).toBeNull();
  });

  it("posting as a Page needs that Page connected", () => {
    const member = { linkedin: { ...conn, platform: "linkedin" as const, userId: "m1" } };
    expect(connectionProblem({ socialConnections: member }, "linkedin", PAGE)).toBe("linkedin_page_not_connected");
    const pages = { linkedin_org: { ...conn, platform: "linkedin_org" as const, orgs: [{ urn: PAGE }] } };
    expect(connectionProblem({ socialConnections: pages }, "linkedin", PAGE)).toBeNull();
    expect(connectionProblem({ socialConnections: pages }, "linkedin", "urn:li:organization:999")).toBe("linkedin_page_not_connected");
  });

  it("channels YouGrow doesn't post itself need nothing", () => {
    expect(connectionProblem(null, "blog")).toBeNull();
    expect(connectionProblem(null, "newsletter")).toBeNull();
  });
});
