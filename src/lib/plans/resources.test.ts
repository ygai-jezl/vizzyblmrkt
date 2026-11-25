import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { PURPOSE_LABELS, purposeLabel, RESOURCES } from "./resources";

describe("what used a resource", () => {
  it("names each kind of writing in a workflow apart, as model use only", () => {
    const split = ["content_write", "content_email", "content_hub", "content_brief", "content_angle"] as const;
    expect(split.map(purposeLabel)).toEqual(["Writing posts", "Writing workflow emails", "Writing hub content", "Writing briefs", "Suggesting angles"]);
    for (const p of split) {
      expect(RESOURCES.model_tokens.purposes, p).toContain(p);
      expect(RESOURCES.web_searches.purposes as readonly string[], p).not.toContain(p);
      expect(RESOURCES.images.purposes as readonly string[], p).not.toContain(p);
    }
  });

  it("labels a stored purpose this copy no longer knows as itself, never as nothing", () => {
    expect(purposeLabel("content_write")).toBe("Writing posts");
    expect(purposeLabel("retired_feature")).toBe("retired_feature");
    // A key that is also an object property name is still only a key.
    expect(purposeLabel("toString")).toBe("toString");
    expect(purposeLabel("__proto__")).toBe("__proto__");
  });

  it("writes every label in house style, each one different", () => {
    const labels = Object.values(PURPOSE_LABELS);
    expect(dashesIn(labels.join("\n"))).toEqual([]);
    expect(aiTellsIn(labels.join("\n"))).toEqual([]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
