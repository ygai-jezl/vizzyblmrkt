import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { CANVAS_KIND_NAMES } from "@/lib/canvas/names";
import { DATA_SIGNAL_RULES } from "@/lib/types/dataSignal";
import { UNSTAMPED_COUNTS } from "./count";
import { LEARN_REASONS } from "./learnLog";
import { CANVAS_TITLES, keyWords, kindLabel, reasonWords, SIGNAL_RULE_LABELS, unstampedWords } from "./reasonWords";
import { LOOPS } from "./registry";
import { IMAGE_POOL, ROW_KINDS } from "./stages";

/** Words a person reads hold to the house style: no dashes as punctuation and none of the AI tells. */
function houseStyle(text: string, where: string): void {
  expect(dashesIn(text), where).toEqual([]);
  expect(aiTellsIn(text), where).toEqual([]);
}

describe("kindLabel", () => {
  it("gives every kind in the learning registry a plain label, never its key", () => {
    for (const kind of Object.keys(LOOPS)) {
      const label = kindLabel(kind);
      expect(label, kind).not.toBe(kind);
      expect(label, kind).not.toBe("Another kind");
      // A capital first, or a name such as eBooks; never a key's underscores.
      expect(label, kind).toMatch(/^(?:[A-Z0-9]|e[A-Z])/);
      expect(label, kind).not.toContain("_");
      houseStyle(label, kind);
    }
  });

  it("names every row of the counts across brands, the image pool included", () => {
    expect(ROW_KINDS).toContain(IMAGE_POOL);
    for (const row of ROW_KINDS) expect(kindLabel(row), row).not.toBe("Another kind");
    expect(kindLabel(IMAGE_POOL)).toBe("Image style");
  });

  it("uses the registry's own labels and each canvas's and connector rule's title", () => {
    expect(kindLabel("send_time")).toBe("Send time");
    expect(kindLabel("edit_memory")).toBe("Memory Bank memories");
    expect(kindLabel("edit_mode")).toBe("Edit mode");
    expect(kindLabel("content_write")).toBe("Writing posts");
    expect(kindLabel("lifecycle_lines")).toBe("AI lines in emails");
    expect(kindLabel("canvas.image_style")).toBe("Image style suggestion");
    expect(kindLabel("image_style_pick")).toBe("Image style used");
    expect(kindLabel("rising_search")).toBe("Rising searches");
    expect(Object.keys(CANVAS_TITLES).sort()).toEqual([...CANVAS_KIND_NAMES].sort());
    expect(Object.keys(SIGNAL_RULE_LABELS).sort()).toEqual([...DATA_SIGNAL_RULES].sort());
  });

  it("never shows a key it doesn't know", () => {
    expect(kindLabel("canvas.not_a_canvas")).toBe("Another kind");
    expect(kindLabel("not_a_kind")).toBe("Another kind");
  });
});

describe("reasonWords", () => {
  it("gives every learner refusal reason a label and words for a sentence, in the house style", () => {
    for (const reason of LEARN_REASONS) {
      const label = reasonWords(reason);
      const inline = reasonWords(reason, "inline");
      expect(label, reason).not.toBe("Another reason");
      expect(label, reason).toMatch(/^[A-Z]/);
      expect(inline, reason).toMatch(/^[a-z]/);
      houseStyle(`${label}. ${inline}.`, reason);
    }
  });

  it("reads the canvas's words for the reasons the Loops section shows most", () => {
    expect(reasonWords("plan")).toBe("Not in the brand's plan");
    expect(reasonWords("plan", "inline")).toBe("not in the brand's plan");
    expect(reasonWords("floor")).toBe("Not enough to learn from yet");
    expect(reasonWords("paused")).toBe("Paused by the brand");
    expect(reasonWords("error")).toBe("The model failed or timed out");
    expect(reasonWords("region", "inline")).toBe("the brand's data is outside Vizzy's region");
  });

  it("never shows a key it doesn't know", () => {
    expect(reasonWords("deadline")).toBe("Another reason");
    expect(reasonWords("deadline", "inline")).toBe("another reason");
  });
});

describe("unstampedWords and keyWords", () => {
  it("gives every reason a save keeps no stamp its words, lost and refused stamps included", () => {
    for (const reason of UNSTAMPED_COUNTS) {
      const words = unstampedWords(reason);
      expect(words, reason).not.toBe("another reason");
      expect(words, reason).toMatch(/^[a-z]/);
      houseStyle(words, reason);
    }
    expect(unstampedWords("own_image")).toBe("a person's own image");
    expect(unstampedWords("token_expired")).toBe("a stamp refused at save");
  });

  it("turns a key from a closed list into words", () => {
    expect(keyWords("not_relevant")).toBe("Not relevant");
    expect(keyWords("unknown")).toBe("Unknown");
    expect(keyWords("")).toBe("Another reason");
  });
});
