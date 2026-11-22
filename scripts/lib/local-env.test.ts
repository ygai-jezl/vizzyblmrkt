import { describe, expect, it } from "vitest";
import { featureSwitchNames, SWITCHES_KEPT_OFF } from "./local-env.mjs";

describe("the switches a local run keeps off", () => {
  it("are all switches apphosting.yaml lists, each with a reason", () => {
    const listed = new Set(featureSwitchNames());
    for (const [name, why] of Object.entries(SWITCHES_KEPT_OFF)) {
      expect(listed.has(name), name).toBe(true);
      expect(String(why).length, name).toBeGreaterThan(20);
    }
  });

  it("keep Google revoke off, because a local sign in uses the dev deployment's Google client", () => {
    // Google's revoke ends every grant that Google account gave the client, so a local Disconnect
    // or purge would end the dev deployment's connections made with the same account.
    expect(SWITCHES_KEPT_OFF).toHaveProperty("CONNECTOR_GOOGLE_REVOKE_ENABLED");
  });
});
