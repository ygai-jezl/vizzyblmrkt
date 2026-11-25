import { describe, expect, it } from "vitest";
import { CANVAS_KIND_NAMES, isCanvasKindName } from "./names";
import { canvasKindNames, getCanvasKind } from "./registry";

/** Typecheck holds names.ts and the registry together; these check what the route sees. */
describe("the canvas registry", () => {
  it("gives a module for every name, in the order of names.ts, each with its own kind", () => {
    expect(canvasKindNames()).toEqual([...CANVAS_KIND_NAMES]);
    for (const name of CANVAS_KIND_NAMES) expect(getCanvasKind(name)?.kind, name).toBe(name);
  });

  it("knows no other kind, not even one an object inherits", () => {
    for (const name of ["", "journeys", "toString", "__proto__", "constructor"]) {
      expect(getCanvasKind(name), name).toBeNull();
      expect(isCanvasKindName(name), name).toBe(false);
    }
    expect(isCanvasKindName(42)).toBe(false);
  });
});
