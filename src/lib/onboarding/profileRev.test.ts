import { describe, expect, it } from "vitest";
import { contextEnvelope } from "@/lib/agents/agentRuntime";
import type { TenantContext } from "@/lib/tenant/types";
import { profileRevFor } from "./profileRev";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_1", role: "admin" };

describe("the profile rev Vizzy caches the profile block by", () => {
  it("ends in the person's view, so a change of role reads the profile again", () => {
    expect(profileRevFor({ rev: 5 }, "admin")).toBe("51");
    expect(profileRevFor({ rev: 5 }, "member")).toBe("50");
    expect(profileRevFor({ rev: 5 }, undefined)).toBe("50");
    // An admin made a member: a new key, never the cached admin block with the kept facts.
    expect(profileRevFor({ rev: 5 }, "member")).not.toBe(profileRevFor({ rev: 5 }, "admin"));
    // A new rev is a new key for both.
    expect(profileRevFor({ rev: 6 }, "admin")).toBe("61");
  });

  it("is empty with no profile, and digits only, so it rides in the envelope", () => {
    expect(profileRevFor(undefined, "admin")).toBe("");
    expect(profileRevFor(null, "admin")).toBe("");
    expect(profileRevFor({ rev: -1 }, "admin")).toBe("01");
    expect(profileRevFor({ rev: 1.5 }, "admin")).toBe("01");
    const env = contextEnvelope(ctx, "t1", undefined, { profileRev: profileRevFor({ rev: 12 }, "admin") });
    expect(env).toContain('"profileRev":"121"');
  });
});
