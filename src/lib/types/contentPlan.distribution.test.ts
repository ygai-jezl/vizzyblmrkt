import { describe, it, expect } from "vitest";
import { ContentNodeSchema } from "./contentPlan";

const base = {
  id: "n1",
  type: "spoke" as const,
  channel: "linkedin",
  role: "LinkedIn Post",
  position: { x: 0, y: 0 },
};

describe("ContentNode distribution status field", () => {
  it("parses a legacy node WITHOUT distributionStatus (back-compat)", () => {
    const n = ContentNodeSchema.parse(base);
    expect(n.distributionStatus ?? null).toBeNull();
    // scheduledAt (its sibling server-owned field) also stays absent.
    expect(n.scheduledAt ?? null).toBeNull();
  });

  it("accepts each valid distribution status", () => {
    for (const s of ["scheduled", "posting", "posted", "failed"] as const) {
      const n = ContentNodeSchema.parse({ ...base, distributionStatus: s });
      expect(n.distributionStatus).toBe(s);
    }
  });

  it("accepts an explicit null (cancel clears it back to the generation badge)", () => {
    const n = ContentNodeSchema.parse({ ...base, distributionStatus: null });
    expect(n.distributionStatus).toBeNull();
  });

  it("rejects an unknown distribution status", () => {
    expect(() => ContentNodeSchema.parse({ ...base, distributionStatus: "queued" })).toThrow();
  });
});
