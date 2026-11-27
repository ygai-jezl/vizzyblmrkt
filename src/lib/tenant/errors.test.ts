import { describe, expect, it } from "vitest";
import { isIndexNotReady } from "./errors";

const grpc = (code: number, message: string) => Object.assign(new Error(message), { code, details: message.replace(/^\d+ [A-Z_]+: /, "") });

describe("isIndexNotReady", () => {
  it("knows Firestore's refusal of a query whose composite index is missing or still building", () => {
    expect(isIndexNotReady(grpc(9, "9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.example.com/indexes"))).toBe(true);
    expect(isIndexNotReady(grpc(9, "9 FAILED_PRECONDITION: The query requires an index. That index is currently building and cannot be used yet."))).toBe(true);
    expect(isIndexNotReady(Object.assign(new Error("The query requires an index."), { code: "failed-precondition" }))).toBe(true);
    expect(isIndexNotReady(new Error("FAILED_PRECONDITION: The query requires an index."))).toBe(true);
  });

  it("is false for every other error", () => {
    expect(isIndexNotReady(grpc(9, "9 FAILED_PRECONDITION: The Cloud Firestore API is not available for this database."))).toBe(false);
    expect(isIndexNotReady(grpc(4, "4 DEADLINE_EXCEEDED: Deadline exceeded"))).toBe(false);
    expect(isIndexNotReady(grpc(14, "14 UNAVAILABLE: The query requires an index."))).toBe(false);
    expect(isIndexNotReady(new Error("count failed"))).toBe(false);
    expect(isIndexNotReady("FAILED_PRECONDITION: The query requires an index.")).toBe(false);
    expect(isIndexNotReady(null)).toBe(false);
    expect(isIndexNotReady(undefined)).toBe(false);
  });
});
