import { describe, expect, it } from "vitest";
import { parseSSE } from "./streamTypes";

describe("parseSSE", () => {
  it("keeps the line breaks inside a streamed text, so a table arrives one row per line", () => {
    const text = "| Page | Clicks |\n| :--- | :---: |\n| / | 1 |\n";
    // As the chat route frames an event, and the client splits records on blank lines.
    const framed = `data: ${JSON.stringify({ type: "text", text })}\n\n`;
    const records = framed.split("\n\n").filter(Boolean);
    expect(records).toHaveLength(1);
    expect(parseSSE(records[0] ?? "")).toEqual({ type: "text", text });
  });

  it("ignores heartbeats, [DONE] and broken JSON", () => {
    expect(parseSSE(": ping")).toBeNull();
    expect(parseSSE("data: [DONE]")).toBeNull();
    expect(parseSSE("data: {nope")).toBeNull();
  });
});
