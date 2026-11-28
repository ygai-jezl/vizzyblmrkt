import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCES } from "@/lib/agentRecord/sources";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { TOKEN_SAVES } from "./handBack";
import { isImageKind } from "./imageKinds";
import { LOOPS, type LoopKind } from "./registry";
import { unusedForWeek } from "./tally";
import { isUnanswered, RECORD_OFF_WHY, RECORD_ONLY, UNANSWERED, unansweredWhy } from "./unanswered";

/**
 * The kinds no path can answer yet (learning loops step 5): left out of unused and shares, so
 * every thing made never reads as unused. Each line says why in house style.
 */

/** Kinds a save, a decision or a record's close counts kept, edited or declined for. */
const ANSWERED: readonly LoopKind[] = [
  "next_up",
  "lifecycle_lines",
  "brand_map_research",
  "content_write",
  "content_email",
  "content_hub",
  "blog_write",
  "blog_refresh",
  "fact_check",
  "vizzy_chat",
  "canvas.invite_wave",
  "canvas.journey",
  "canvas.lifecycle",
  "canvas.journey_style",
  "canvas.email_style",
  "canvas.image_style",
  "canvas.person_fields",
  "canvas.new_person",
];

afterEach(() => vi.unstubAllEnvs());

describe("the kinds no path can answer yet", () => {
  it("are kinds of the registry with words, never an image kind, whose votes answer them", () => {
    for (const kind of Object.keys(UNANSWERED)) {
      expect(Object.prototype.hasOwnProperty.call(LOOPS, kind), kind).toBe(true);
      expect(isImageKind(kind), kind).toBe(false);
      expect(isUnanswered(kind)).toBe(true);
    }
    expect(isUnanswered("toString")).toBe(false);
  });

  it("leave out every kind a save, a decision or a stamp token answers, with the agent record on", () => {
    vi.stubEnv("AGENT_RECORD_ENABLED", "true");
    for (const kind of [...ANSWERED, ...TOKEN_SAVES]) expect(isUnanswered(kind), kind).toBe(false);
  });

  it("take in the kinds only the agent record answers while it is off, as it ships", () => {
    vi.stubEnv("AGENT_RECORD_ENABLED", "false");
    for (const kind of RECORD_ONLY) expect(unansweredWhy(kind), kind).toBe(RECORD_OFF_WHY);
    for (const kind of [...ANSWERED.filter((k) => !RECORD_ONLY.includes(k)), ...TOKEN_SAVES]) expect(isUnanswered(kind), kind).toBe(false);
    expect(unansweredWhy("send_time")).toBe(UNANSWERED.send_time);
    // Four journeys Vizzy drafted for Hearth Bakery: no record keeps their stamps, so none reads as unused.
    const drafted = { c: { "canvas.journey": { "canvas.journey": { v0: { none: { made: 4 } } } } } };
    expect(unusedForWeek([drafted, undefined, undefined]).has("canvas.journey")).toBe(false);
    vi.stubEnv("AGENT_RECORD_ENABLED", "true");
    expect(unansweredWhy("canvas.journey")).toBeNull();
    expect(unusedForWeek([drafted, undefined, undefined]).get("canvas.journey")).toBe(4);
  });

  it("list every kind the agent record answers at its transition and no other path does", () => {
    // Vizzy's notes count no made while the record is off; the product map counts none at all.
    const elsewhere: Partial<Record<LoopKind, string>> = { vizzy_chat: "brand notes", product_map: "no made" };
    const transition = [...new Set(SOURCES.filter((l) => l.countsAt === "transition").map((l) => l.loop as LoopKind))];
    expect([...RECORD_ONLY].sort()).toEqual(transition.filter((k) => !elsewhere[k]).sort());
    // Each is answered once the record is on, so none sits in UNANSWERED for good.
    for (const kind of RECORD_ONLY) expect(Object.prototype.hasOwnProperty.call(UNANSWERED, kind), kind).toBe(false);
  });

  it("say why in house style", () => {
    for (const [kind, why] of Object.entries({ ...UNANSWERED, record_off: RECORD_OFF_WHY })) {
      expect(why!.trim().length, kind).toBeGreaterThan(20);
      expect(dashesIn(why!), kind).toEqual([]);
      expect(aiTellsIn(why!), kind).toEqual([]);
    }
  });
});
