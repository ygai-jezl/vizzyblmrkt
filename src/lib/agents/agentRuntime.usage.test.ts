import { describe, expect, it } from "vitest";
import { addChatUsage, parseUpstreamRecords } from "./agentRuntime";

// Vizzy's chat tokens are counted from the agent's own events (Agent Engine sends ADK events as
// snake_case JSON): only events that aren't partial, by model.
describe("Vizzy chat tokens", () => {
  it("adds final events' tokens by model, and skips partials", () => {
    const lines = [
      `data: ${JSON.stringify({ content: { parts: [{ text: "Hel" }] }, partial: true, usage_metadata: { total_token_count: 900 }, model_version: "gemini-3.8-flash" })}`,
      `data: ${JSON.stringify({ content: { parts: [{ text: "Hello" }] }, usage_metadata: { total_token_count: 1200 }, model_version: "gemini-3.8-flash" })}`,
      `data: ${JSON.stringify({ content: { parts: [{ function_call: { name: "get_usage" } }] }, usage_metadata: { total_token_count: 300 }, model_version: "gemini-3.8-flash" })}`,
      `data: ${JSON.stringify({ content: { parts: [{ text: "Done." }] }, usageMetadata: { totalTokenCount: 50 }, modelVersion: "gemini-3.1-pro" })}`,
      `data: ${JSON.stringify({ content: { parts: [{ text: "no usage" }] } })}`,
    ];
    const totals = new Map<string, number>();
    for (const evt of parseUpstreamRecords(lines)) addChatUsage(evt, totals);
    expect(Object.fromEntries(totals)).toEqual({ "gemini-3.8-flash": 1500, "gemini-3.1-pro": 50 });
  });
});
