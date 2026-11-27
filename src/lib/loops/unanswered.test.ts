import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { TOKEN_SAVES } from "./handBack";
import { isImageKind } from "./imageKinds";
import { LOOPS, type LoopKind } from "./registry";
import { isUnanswered, UNANSWERED } from "./unanswered";

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

describe("the kinds no path can answer yet", () => {
  it("are kinds of the registry with words, never an image kind, whose votes answer them", () => {
    for (const kind of Object.keys(UNANSWERED)) {
      expect(Object.prototype.hasOwnProperty.call(LOOPS, kind), kind).toBe(true);
      expect(isImageKind(kind), kind).toBe(false);
      expect(isUnanswered(kind)).toBe(true);
    }
    expect(isUnanswered("toString")).toBe(false);
  });

  it("leave out every kind a save, a decision or a stamp token answers", () => {
    for (const kind of [...ANSWERED, ...TOKEN_SAVES]) expect(isUnanswered(kind), kind).toBe(false);
  });

  it("say why in house style", () => {
    for (const [kind, why] of Object.entries(UNANSWERED)) {
      expect(why!.trim().length, kind).toBeGreaterThan(20);
      expect(dashesIn(why!), kind).toEqual([]);
      expect(aiTellsIn(why!), kind).toEqual([]);
    }
  });
});
