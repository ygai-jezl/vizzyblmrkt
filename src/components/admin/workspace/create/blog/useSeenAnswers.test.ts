import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_WAIT_MS, createAnswerQueue, type AnswerSave } from "./useSeenAnswers";

const URL = "/api/admin/workspace/ws_1/content-plans/plan_1/blog/seen/answer";

function setup(ok: () => boolean = () => true) {
  const states: Array<[string, AnswerSave]> = [];
  const bodies: Array<{ noteId: string; text: string; done: boolean; keepalive?: boolean }> = [];
  let release: Array<() => void> = [];
  let hold = false;
  const send = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push({ ...JSON.parse(String(init?.body)), ...(init?.keepalive ? { keepalive: true } : {}) });
    if (hold) await new Promise<void>((r) => release.push(r));
    return { ok: ok() } as Response;
  });
  const queue = createAnswerQueue(URL, (id, s) => states.push([id, s]), send as unknown as typeof fetch);
  return {
    queue,
    send,
    states,
    bodies,
    holdNext: () => (hold = true),
    releaseAll: () => {
      hold = false;
      const r = release;
      release = [];
      r.forEach((f) => f());
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("answers saved as they are typed", () => {
  it("are sent a second after typing stops, once, with the newest text", async () => {
    const t = setup();
    t.queue.save("bn_1", "We ran");
    t.queue.save("bn_1", "We ran it daily");
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 1);
    expect(t.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.bodies).toEqual([{ noteId: "bn_1", text: "We ran it daily", done: false }]);
    expect(t.states.at(-1)).toEqual(["bn_1", "saved"]);
  });

  it("send one at a time per question, then what came in meanwhile", async () => {
    const t = setup();
    t.holdNext();
    t.queue.save("bn_1", "first");
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    t.queue.save("bn_1", "second");
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(t.send).toHaveBeenCalledTimes(1);
    t.releaseAll();
    await vi.runAllTimersAsync();
    expect(t.bodies.map((b) => b.text)).toEqual(["first", "second"]);
    expect(t.states.at(-1)).toEqual(["bn_1", "saved"]);
  });

  it("save at once on leaving the box, saying it is done, even after the timed save went", async () => {
    const t = setup();
    t.queue.save("bn_1", "We ran it daily for a week");
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    t.queue.done("bn_1");
    await vi.runAllTimersAsync();
    expect(t.bodies).toEqual([
      { noteId: "bn_1", text: "We ran it daily for a week", done: false },
      { noteId: "bn_1", text: "We ran it daily for a week", done: true },
    ]);
    // Leaving again with nothing new sends nothing.
    t.queue.done("bn_1");
    t.queue.done("bn_2");
    await vi.runAllTimersAsync();
    expect(t.send).toHaveBeenCalledTimes(2);
  });

  it("keep a failed save and send it again on flush", async () => {
    let ok = false;
    const t = setup(() => ok);
    t.queue.save("bn_1", "We ran it daily");
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(t.states.at(-1)).toEqual(["bn_1", "failed"]);
    ok = true;
    await t.queue.flush();
    expect(t.bodies.map((b) => b.text)).toEqual(["We ran it daily", "We ran it daily"]);
    expect(t.states.at(-1)).toEqual(["bn_1", "saved"]);
  });

  it("are all finished by flush before the canvas saves", async () => {
    const t = setup();
    t.queue.save("bn_1", "one");
    t.queue.save("bn_2", "two");
    await t.queue.flush();
    expect(t.bodies.map((b) => b.noteId).sort()).toEqual(["bn_1", "bn_2"]);
    await vi.runAllTimersAsync();
    expect(t.send).toHaveBeenCalledTimes(2);
  });

  it("go with keepalive when the page is left, once, and the queue still works after", async () => {
    const t = setup();
    t.queue.save("bn_1", "half typed");
    t.queue.leave();
    expect(t.bodies).toEqual([{ noteId: "bn_1", text: "half typed", done: true, keepalive: true }]);
    await vi.runAllTimersAsync();
    expect(t.send).toHaveBeenCalledTimes(1);
    t.queue.save("bn_1", "half typed, then more");
    await vi.runAllTimersAsync();
    expect(t.bodies.at(-1)).toEqual({ noteId: "bn_1", text: "half typed, then more", done: false });
  });
});
