import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRegion } from "./agentRuntime";

afterEach(() => vi.unstubAllEnvs());

describe("agentRegion", () => {
  it("maps the agent's location to a data region", () => {
    expect(agentRegion("us-central1")).toBe("us");
    expect(agentRegion("us-east4")).toBe("us");
    expect(agentRegion("europe-west4")).toBe("eu");
    expect(agentRegion(" Europe-West1 ")).toBe("eu");
    expect(agentRegion("asia-southeast1")).toBe("asia");
  });

  it("gives no region for any other location, so no brand counts as inside it by mistake", () => {
    for (const location of ["", "us", "eu", "global", "northamerica-northeast1", "australia-southeast1", "me-west1", "useast"]) {
      expect(agentRegion(location)).toBeNull();
    }
  });

  it("reads ROOT_AGENT_LOCATION, us-central1 when it is unset", () => {
    vi.stubEnv("ROOT_AGENT_LOCATION", "europe-west4");
    expect(agentRegion()).toBe("eu");
    vi.unstubAllEnvs();
    delete process.env.ROOT_AGENT_LOCATION;
    expect(agentRegion()).toBe("us");
  });
});
