import { describe, it, expect } from "vitest";
import { TenantSchema } from "./tenant";

describe("TenantSchema.gitConnections", () => {
  const field = TenantSchema.shape.gitConnections;
  const conn = {
    provider: "github" as const,
    enc: { ct: "a", iv: "b", tag: "c" },
    connectedAt: "2026-06-30T00:00:00.000Z",
  };

  it("is optional", () => {
    expect(field.parse(undefined)).toBeUndefined();
    expect(field.parse({})).toEqual({});
  });

  it("accepts a SINGLE connected provider (must not be exhaustive)", () => {
    // Regression: an enum-keyed z.record required BOTH github+gitlab and 500'd a
    // tenant that had only connected github.
    expect(field.parse({ github: conn })).toEqual({ github: conn });
  });

  it("accepts both providers", () => {
    const both = { github: conn, gitlab: { ...conn, provider: "gitlab" as const } };
    expect(field.parse(both)).toEqual(both);
  });
});
