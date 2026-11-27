import { describe, expect, it } from "vitest";
import { CANVAS_KIND_NAMES } from "@/lib/canvas/names";
import { LOOPS } from "@/lib/loops/registry";
import { typeById } from "@/lib/ontology/registry";
import { REVIEW_SECTIONS } from "@/lib/review/summary";
import { AGENT_ACTION_LIMITS, AGENT_ACTION_NAME, AGENT_NAMES } from "@/lib/types/agentAction";
import { CANVAS_LINES, DRAFT_KINDS, DRAFT_TYPE, lineByKey, lineFor, RECORD_ACTIONS, SOURCES, type SourceLine } from "./sources";

const lines = SOURCES as readonly SourceLine[];

describe("agent record sources", () => {
  it("keeps the 12 actions of the plan, each once, with a key Vizzy reads it by", () => {
    expect(RECORD_ACTIONS).toHaveLength(12);
    expect(new Set(RECORD_ACTIONS).size).toBe(12);
    expect(new Set(lines.map((l) => l.key)).size).toBe(12);
    for (const l of lines) {
      expect(l.action, l.key).toMatch(AGENT_ACTION_NAME);
      expect(lineFor(l.action)).toBe(l);
      expect(lineByKey(l.key)).toBe(l);
      expect(AGENT_NAMES).toContain(l.agent);
    }
    expect(lineFor("person_fields.suggest")).toBeNull();
  });

  it("gives every canvas kind a line or a reason", () => {
    for (const name of CANVAS_KIND_NAMES) {
      const line = CANVAS_LINES[name];
      expect(line, name).toBeDefined();
      if ("action" in line) expect(lineFor(line.action), name).not.toBeNull();
      else expect(line.none.length, name).toBeGreaterThan(20);
    }
    // Decision 2: a plan for one person stays out; field suggestions and New person record already.
    expect(CANVAS_LINES.person_plan).toHaveProperty("none");
    expect(CANVAS_LINES.person_fields).toHaveProperty("none");
    expect(CANVAS_LINES.new_person).toHaveProperty("none");
  });

  it("names a loop kind with a line in LOOPS and a Review section for each", () => {
    for (const l of lines) {
      expect(Object.keys(LOOPS), l.key).toContain(l.loop);
      expect(REVIEW_SECTIONS[l.review], l.key).toBeDefined();
    }
  });

  it("points every draft at a built type in the ontology registry", () => {
    for (const kind of DRAFT_KINDS) {
      const type = typeById(DRAFT_TYPE[kind]);
      expect(type, kind).toBeDefined();
      expect(type!.status, kind).toBe("built");
    }
    for (const l of lines) for (const d of l.drafts) expect(DRAFT_KINDS, l.key).toContain(d);
  });

  it("says where the loops count each outcome, and never expires past 90 days", () => {
    for (const l of lines) {
      expect(["own_path", "transition"], l.key).toContain(l.countsAt);
      expect(l.expiryDays, l.key).toBeGreaterThan(0);
      expect(l.expiryDays, l.key).toBeLessThanOrEqual(AGENT_ACTION_LIMITS.maxExpiryDays);
    }
    // Content plans, the autopilot, invite waves and map runs count at their own paths (loops step 5).
    const own = lines.filter((l) => l.countsAt === "own_path").map((l) => l.action).sort();
    expect(own).toEqual(["autopilot.draft", "brand_map.research", "brand_map.suggest", "content_plan.draft", "invite_wave.draft"]);
  });

  it("keeps the brand's styles and notes for admins only, as on their pages", () => {
    expect(lines.filter((l) => l.adminOnly).map((l) => l.key).sort()).toEqual(["brand_note", "email_style", "image_style"]);
  });
});
