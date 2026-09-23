import { describe, it, expect } from "vitest";
import type { TenantContext } from "@/lib/tenant/types";
import { contextEnvelope } from "./agentRuntime";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", userId: "u1", source: "idtoken" };

/** The agent parses `[ctx:{...}]` with a non-greedy `\{.*?\}\]` — mirror that here. */
function parse(envelope: string): Record<string, unknown> {
  const m = /^\s*\[ctx:(\{.*?\})\]\s*/s.exec(envelope);
  if (!m) throw new Error(`no envelope in ${envelope}`);
  return JSON.parse(m[1]!) as Record<string, unknown>;
}

describe("contextEnvelope page context", () => {
  it("carries the page the admin is on", () => {
    const env = contextEnvelope(ctx, "t1", "fast", { page: "Launches › Fernlight Beta › Signups", campaignId: "c1" });
    expect(parse(env)).toMatchObject({ page: "Launches › Fernlight Beta › Signups", campaignId: "c1", tenantId: "ten_A" });
    expect(env).toContain("[mode:fast]");
  });

  it("leaves page out when there is none", () => {
    expect(parse(contextEnvelope(ctx, "t1", undefined, { page: null }))).not.toHaveProperty("page");
  });
});
