import { describe, it, expect } from "vitest";
import { ContextResponseSchema, IngestMessageSchema } from "./protocol";

describe("message schemas", () => {
  const ok = { messageId: "m1", userId: "u1", timestamp: "2026-09-21T10:00:00Z" };

  it("accepts identify and track, rejecting unzoned timestamps and bad names", () => {
    expect(IngestMessageSchema.safeParse({ type: "identify", ...ok, traits: { plan: "pro" } }).success).toBe(true);
    expect(IngestMessageSchema.safeParse({ type: "track", ...ok, event: "user.signed_up" }).success).toBe(true);
    expect(IngestMessageSchema.safeParse({ type: "track", ...ok, event: "User Signed Up" }).success).toBe(false);
    expect(
      IngestMessageSchema.safeParse({ type: "identify", ...ok, timestamp: "2026-09-21T10:00:00" }).success,
    ).toBe(false);
    expect(IngestMessageSchema.safeParse({ type: "alias", ...ok }).success).toBe(false);
  });

  it("rejects nested trait values and more than 50 traits", () => {
    expect(IngestMessageSchema.safeParse({ type: "identify", ...ok, traits: { a: { b: 1 } } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`t${i}`, i]));
    expect(IngestMessageSchema.safeParse({ type: "identify", ...ok, traits: many }).success).toBe(false);
  });

  it("parses a context response and caps its lists", () => {
    const good = ContextResponseSchema.safeParse({
      asOf: "2026-09-21T10:00:00Z",
      steps: [{ id: "create_brand", label: "Create brand", done: true }],
      facts: [{ id: "sov", label: "Share of voice", value: 12.5, unit: "%" }],
      insights: [{ id: "i1", sentence: "ChatGPT named 3 competitors but not you.", factIds: ["sov"] }],
    });
    expect(good.success).toBe(true);
    const tooMany = ContextResponseSchema.safeParse({
      asOf: "2026-09-21T10:00:00Z",
      insights: Array.from({ length: 21 }, (_, i) => ({ id: `i${i}`, sentence: "x" })),
    });
    expect(tooMany.success).toBe(false);
  });
});
