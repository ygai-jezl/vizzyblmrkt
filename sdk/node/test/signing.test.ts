import { describe, it, expect } from "vitest";
import vectorsFile from "./vectors.json";
import { sign, verify, type Direction } from "../src/signing.js";

const vectors = vectorsFile.vectors as Array<{
  secret: string;
  direction: Direction;
  timestamp: number;
  body: string;
  signature: string;
}>;

describe("SDK signing matches the shared vectors", () => {
  it.each(vectors.map((v, i) => [i, v] as const))("vector %i", (_i, v) => {
    expect(sign(v.secret, v.direction, v.timestamp, v.body)).toBe(v.signature);
    expect(
      verify({
        secrets: [v.secret],
        direction: v.direction,
        timestamp: String(v.timestamp),
        signature: v.signature,
        rawBody: v.body,
        nowMs: v.timestamp * 1000,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses stale requests and the wrong direction", () => {
    const v = vectors[0]!;
    const base = { secrets: [v.secret], timestamp: String(v.timestamp), signature: v.signature, rawBody: v.body };
    expect(verify({ ...base, direction: v.direction, nowMs: (v.timestamp + 600) * 1000 })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
    expect(verify({ ...base, direction: "webhook", nowMs: v.timestamp * 1000 })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});
