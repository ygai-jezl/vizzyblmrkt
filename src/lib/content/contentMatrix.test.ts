import { describe, it, expect } from "vitest";
import {
  CONTENT_MATRIX_TOPICS,
  isContentMatrixTopic,
  contentMatrixLabel,
} from "./contentMatrix";

describe("Content Matrix", () => {
  it("has 26 unique topic ids", () => {
    expect(CONTENT_MATRIX_TOPICS).toHaveLength(26);
    expect(new Set(CONTENT_MATRIX_TOPICS.map((t) => t.id)).size).toBe(26);
  });

  it("validates topic ids", () => {
    expect(isContentMatrixTopic("systems")).toBe(true);
    expect(isContentMatrixTopic("writing")).toBe(true);
    expect(isContentMatrixTopic("self-promotion")).toBe(true);
    expect(isContentMatrixTopic("not-a-topic")).toBe(false);
    expect(isContentMatrixTopic("")).toBe(false);
  });

  it("resolves labels (falls back to the id)", () => {
    expect(contentMatrixLabel("self-promotion")).toBe("Self-promotion");
    expect(contentMatrixLabel("unknown-id")).toBe("unknown-id");
  });
});
