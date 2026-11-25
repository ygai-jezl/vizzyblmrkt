import { describe, expect, it, vi } from "vitest";

vi.mock("../nav/WordsProvider", () => ({ useWords: () => ({ ideas: true }) }));
const { watchComparePicks } = await import("./ComparePicks");

type Box = { checked: boolean; disabled: boolean };
const box = (checked = false): Box => ({ checked, disabled: false });

/** A stand-in for the list's GET form: its compare boxes, its listeners and a rows observer. */
function world(initial: Box[]) {
  let boxes = initial;
  const listeners = new Map<string, () => void>();
  const observers: Array<{ cb: () => void; opts: MutationObserverInit | null; on: boolean }> = [];
  const form = {
    querySelectorAll: () => boxes,
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  class FakeObserver {
    rec: (typeof observers)[number];
    constructor(cb: () => void) {
      this.rec = { cb, opts: null, on: false };
      observers.push(this.rec);
    }
    observe(_target: never, opts: MutationObserverInit) {
      this.rec.opts = opts;
      this.rec.on = true;
    }
    disconnect() {
      this.rec.on = false;
    }
  }
  const counts: number[] = [];
  const stop = watchComparePicks(form as never, (n) => counts.push(n), FakeObserver as never);
  return {
    counts,
    stop,
    listeners,
    observers,
    /** A client navigation (a status pill, say) puts new rows under the same bar. */
    swapRows(next: Box[]) {
      boxes = next;
      for (const o of observers) if (o.on) o.cb();
    },
    get boxes() {
      return boxes;
    },
  };
}

describe("the compare bar's count", () => {
  it("counts the ticks, and turns the other boxes off at four", () => {
    const w = world([box(), box(), box(), box(), box()]);
    expect(w.counts.at(-1)).toBe(0);
    for (const b of w.boxes.slice(0, 4)) b.checked = true;
    w.listeners.get("change")!();
    expect(w.counts.at(-1)).toBe(4);
    expect(w.boxes.map((b) => b.disabled)).toEqual([false, false, false, false, true]);
  });

  it("counts again when a status pill swaps the rows under the bar, so two ticks on the old rows don't stay picked", () => {
    const w = world([box(), box(), box()]);
    w.boxes[0]!.checked = true;
    w.boxes[1]!.checked = true;
    w.listeners.get("change")!();
    expect(w.counts.at(-1)).toBe(2);

    w.swapRows([box()]);
    expect(w.counts.at(-1)).toBe(0);
    expect(w.observers[0]!.opts).toMatchObject({ childList: true, subtree: true });
    // Only rows: a box turned off is an attribute change, which must not count again in a loop.
    expect(w.observers[0]!.opts).not.toHaveProperty("attributes", true);
  });

  it("stops listening and watching on cleanup", () => {
    const w = world([box()]);
    w.stop();
    expect(w.listeners.size).toBe(0);
    expect(w.observers.every((o) => !o.on)).toBe(true);
  });
});
