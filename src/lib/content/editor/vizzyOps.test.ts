import { describe, expect, it } from "vitest";
import { VIZZY_LIMITS, VizzyRequestSchema, extractVizzyResult, replyBoundary } from "./vizzyOps";

describe("the request", () => {
  const selection = {
    format: "blog",
    mode: "selection",
    shape: "inline",
    instruction: "make it shorter",
    selection: "Most launches slip.",
  };

  it("takes a selection with its context defaulted", () => {
    const r = VizzyRequestSchema.safeParse(selection);
    expect(r.success).toBe(true);
    expect(r.success && r.data.mode === "selection" && r.data.before).toBe("");
  });

  it("refuses an empty request, a long selection and an unknown format", () => {
    expect(VizzyRequestSchema.safeParse({ ...selection, instruction: "  " }).success).toBe(false);
    expect(VizzyRequestSchema.safeParse({ ...selection, selection: "x".repeat(VIZZY_LIMITS.SELECTION + 1) }).success).toBe(false);
    expect(VizzyRequestSchema.safeParse({ ...selection, format: "pdf" }).success).toBe(false);
  });

  it("caps the whole piece at the article limit, except for emails", () => {
    const long = "x".repeat(VIZZY_LIMITS.MARKDOWN + 1);
    expect(VizzyRequestSchema.safeParse({ format: "blog", mode: "whole", instruction: "fix", text: long }).success).toBe(false);
    expect(VizzyRequestSchema.safeParse({ format: "email", mode: "whole", instruction: "fix", text: long }).success).toBe(true);
  });
});

describe("the answer in a reply", () => {
  it("reads a selection's replacement from the ops fence", () => {
    const reply = 'Cut it to one sentence.\n```ops\n{"replacement":"Most launches slip."}\n```';
    expect(extractVizzyResult(reply, "selection")).toEqual({ mode: "selection", replacement: "Most launches slip.", note: undefined });
  });

  it("keeps a code fence inside the replacement whole", () => {
    const replacement = "Run this:\n\n```bash\nnpm test\n```";
    const reply = `Done.\n\`\`\`ops\n${JSON.stringify({ replacement })}\n\`\`\``;
    expect(extractVizzyResult(reply, "selection")).toMatchObject({ replacement });
  });

  it("reads a bare object when the model skips the fence", () => {
    const reply = 'Changed two words. {"ops":[{"op":"replace","find":"color","replace":"colour"}]}';
    expect(extractVizzyResult(reply, "whole")).toMatchObject({ ops: [{ op: "replace", find: "color" }], dropped: 0 });
  });

  it("drops bad edits, counts them and caps the rest", () => {
    const ops = [
      { op: "replace", find: "a", replace: "b" },
      { op: "delete_everything" },
      { op: "replace_all", find: "<b>", replace: "x" },
      ...Array.from({ length: VIZZY_LIMITS.OPS + 2 }, (_, i) => ({ op: "insert_after", after: `word ${i}`, insert: "New." })),
    ];
    const r = extractVizzyResult(`ok\n\`\`\`ops\n${JSON.stringify({ ops, note: " Two places were unclear. " })}\n\`\`\``, "whole");
    expect(r?.mode === "whole" && r.ops.length).toBe(VIZZY_LIMITS.OPS);
    expect(r?.mode === "whole" && r.dropped).toBe(5);
    expect(r?.note).toBe("Two places were unclear.");
  });

  it("returns null when there is no answer", () => {
    expect(extractVizzyResult("I can't do that here.", "whole")).toBeNull();
    expect(extractVizzyResult("```ops\nnot json\n```", "selection")).toBeNull();
  });

  it("finds where the machine-only part starts", () => {
    expect(replyBoundary("Hello there")).toBe(-1);
    expect(replyBoundary("Done.\n```ops")).toBe(6);
    expect(replyBoundary('Done. {"ops": []}')).toBe(6);
  });
});
