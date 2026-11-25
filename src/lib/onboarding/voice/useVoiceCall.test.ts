import { describe, expect, it, vi } from "vitest";
import type { LiveServerMessage } from "@google/genai";
import { START_MESSAGE, TIME_MESSAGE } from "./transcript";
import { VoiceCallController, type LiveCallbacks, type VoiceCallDeps } from "./useVoiceCall";

// The whole Talk with Vizzy flow with the browser faked: the audio, the microphone, Gemini Live
// and our routes. Nothing leaves the test.

type Reply = { status: number; body: unknown };

function harness(replies: Partial<Record<"start" | "turns" | "end", Reply | Reply[]>> = {}) {
  let now = 1_000_000;
  const calls: Array<{ url: string; body: Record<string, unknown>; keepalive?: boolean }> = [];
  const timers = new Map<number, () => void>();
  let pageHide: (() => void) | null = null;
  let live: LiveCallbacks | null = null;
  const mic = { start: vi.fn(), setMuted: vi.fn(), close: vi.fn() };
  const player = { playing: false, push: vi.fn(), clear: vi.fn(), drained: vi.fn(async () => {}) };
  const session = { sendClientContent: vi.fn(), sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() };
  const track = { stop: vi.fn() };
  const audioClose = vi.fn();
  const queue = (k: "start" | "turns" | "end"): Reply => {
    const r = replies[k];
    if (Array.isArray(r)) return r.length > 1 ? r.shift()! : r[0]!;
    return r ?? { status: 200, body: k === "start" ? { conversationId: "oc_1", token: "tok", model: "m", callSeconds: 300 } : { ok: true, length: 0 } };
  };
  const deps: VoiceCallDeps = {
    openAudio: () => ({ mic: () => mic, player: () => player, close: audioClose }),
    askForMicrophone: vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream),
    connect: vi.fn(async (_token: string, _model: string, cb: LiveCallbacks) => {
      live = cb;
      return session;
    }),
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body, keepalive: init.keepalive });
      const kind = url.endsWith("/voice/start") ? "start" : url.endsWith("/turns") ? "turns" : "end";
      const r = queue(kind);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }),
    now: () => now,
    every(fn, ms) {
      timers.set(ms, fn);
      return () => timers.delete(ms);
    },
    sleep: async () => {},
    onPageHide(fn) {
      pageHide = fn;
      return () => {
        pageHide = null;
      };
    },
  };
  const views: unknown[] = [];
  const ctl = new VoiceCallController(deps, (v) => views.push(v));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    ctl,
    deps,
    calls,
    mic,
    player,
    session,
    track,
    audioClose,
    settle,
    message: (m: Partial<LiveServerMessage>) => live!.onmessage(m as LiveServerMessage),
    close: () => live!.onclose(),
    later: (seconds: number) => {
      now += seconds * 1000;
    },
    tick: () => timers.get(1000)?.(),
    flushTimer: () => timers.get(5000)?.(),
    hidePage: () => pageHide?.(),
    timersRunning: () => timers.size,
  };
}

const heard = (who: "member" | "vizzy", text: string, done = false): Partial<LiveServerMessage> => ({
  serverContent: who === "member" ? { inputTranscription: { text } } : { outputTranscription: { text }, ...(done ? { turnComplete: true } : {}) },
});

async function talking(h: ReturnType<typeof harness>) {
  h.ctl.start();
  expect(h.ctl.view.phase).toBe("mic");
  await h.settle();
  expect(h.ctl.view.phase).toBe("talking");
}

describe("a Talk with Vizzy call", () => {
  it("asks for the microphone, then a token, then connects and asks Vizzy to say hello", async () => {
    const h = harness();
    await talking(h);
    expect(h.calls[0]).toEqual({ url: "/api/admin/onboarding/voice/start", body: {}, keepalive: undefined });
    expect(h.deps.connect).toHaveBeenCalledWith("tok", "m", expect.any(Object));
    expect(h.session.sendClientContent).toHaveBeenCalledWith({ turns: [{ role: "user", parts: [{ text: START_MESSAGE }] }], turnComplete: true });
    expect(h.mic.start).toHaveBeenCalled();
    expect(h.ctl.view).toMatchObject({ secondsLeft: 300, callSeconds: 300, problem: null });
  });

  it("writes down both sides, plays Vizzy, and stops Vizzy when talked over", async () => {
    const h = harness();
    await talking(h);
    h.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }] } } });
    expect(h.player.push).toHaveBeenCalledWith("AAAA");
    h.message(heard("vizzy", "Hi! What do you"));
    h.message(heard("vizzy", " sell?", true));
    h.later(4);
    h.message(heard("member", "Plants,"));
    h.message(heard("member", " mostly."));
    expect(h.ctl.view.transcript).toEqual({
      lines: [{ who: "vizzy", text: "Hi! What do you sell?", atSec: 0 }],
      partial: { who: "member", text: "Plants, mostly.", atSec: 4 },
    });
    h.message({ serverContent: { interrupted: true } });
    expect(h.player.clear).toHaveBeenCalled();
  });

  it("ticks a topic on Vizzy's silent note and answers it silently", async () => {
    const h = harness();
    await talking(h);
    h.message({ toolCall: { functionCalls: [{ id: "c1", name: "note_answer", args: { topic: "who", choice: "team", words: "three of us" } }] } });
    expect(h.ctl.view.topics[0]).toMatchObject({ key: "who", state: "done", answer: "A small team" });
    expect(h.ctl.view.topics[1]).toMatchObject({ state: "now" });
    expect(h.session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{ id: "c1", name: "note_answer", response: { ok: true }, scheduling: "SILENT" }],
    });
    // A note that isn't one is answered but changes nothing.
    h.message({ toolCall: { functionCalls: [{ id: "c2", name: "note_answer", args: { topic: "who", choice: "robot" } }] } });
    expect(h.ctl.view.topics[0]).toMatchObject({ answer: "A small team" });
  });

  it("counts down from the open connection, says [Time] once with a minute left, and ends at 0", async () => {
    const h = harness({ end: { status: 200, body: { learned: true, answers: {} } } });
    await talking(h);
    h.later(239);
    h.tick();
    expect(h.ctl.view.secondsLeft).toBe(61);
    expect(h.session.sendRealtimeInput).not.toHaveBeenCalledWith({ text: TIME_MESSAGE });
    h.later(1);
    h.tick();
    h.tick();
    expect(h.session.sendRealtimeInput.mock.calls.filter(([a]) => a.text === TIME_MESSAGE)).toHaveLength(1);
    h.later(60);
    h.tick();
    await h.settle();
    expect(h.ctl.view.phase).toBe("ended");
    expect(h.calls.at(-1)).toMatchObject({ url: "/api/admin/onboarding/conversations/oc_1/end", body: { reason: "time" } });
  });

  it("sends finished lines every few seconds, from where the server is", async () => {
    const h = harness({ turns: [{ status: 200, body: { ok: true, length: 1 } }, { status: 409, body: { error: "out_of_order", length: 0 } }] });
    await talking(h);
    h.message(heard("vizzy", "Hi!", true));
    h.message({ toolCall: { functionCalls: [{ id: "n", name: "note_answer", args: { topic: "run", choice: "shop" } }] } });
    h.flushTimer();
    await h.settle();
    expect(h.calls.at(-1)).toEqual({
      url: "/api/admin/onboarding/conversations/oc_1/turns",
      body: { from: 0, turns: [{ who: "vizzy", text: "Hi!", atSec: 0 }], notes: [{ topic: "run", choice: "shop" }] },
      keepalive: undefined,
    });
    // Nothing new: nothing sent.
    h.flushTimer();
    await h.settle();
    expect(h.calls.filter((c) => c.url.endsWith("/turns"))).toHaveLength(1);
    h.later(3);
    h.message(heard("member", "Hello"));
    h.message({ serverContent: { turnComplete: true } });
    h.flushTimer();
    await h.settle();
    expect(h.calls.at(-1)!.body).toMatchObject({ from: 1, turns: [{ who: "member", text: "Hello", atSec: 3 }], notes: [] });
  });

  it("mutes the microphone and tells Live the audio stopped", async () => {
    const h = harness();
    await talking(h);
    h.ctl.toggleMute();
    expect(h.mic.setMuted).toHaveBeenCalledWith(true);
    expect(h.session.sendRealtimeInput).toHaveBeenCalledWith({ audioStreamEnd: true });
    expect(h.ctl.view.muted).toBe(true);
    h.ctl.toggleMute();
    expect(h.mic.setMuted).toHaveBeenLastCalledWith(false);
    expect(h.ctl.view.muted).toBe(false);
  });

  it("ends on End: stops everything, sends the rest with the line being heard, and shows what the server learned", async () => {
    const h = harness({ end: { status: 200, body: { lengthSec: 80, covered: ["who", "run"], answers: { who: "solo", run: "shop" }, learned: true } } });
    await talking(h);
    h.message({ toolCall: { functionCalls: [{ id: "n", name: "note_answer", args: { topic: "who", choice: "team" } }] } });
    h.message(heard("vizzy", "Hi!", true));
    h.later(83);
    h.message(heard("member", "Just me, a plant shop"));
    h.ctl.end();
    expect(h.ctl.view.phase).toBe("ended");
    expect(h.ctl.view.ended).toEqual({ conversationId: "oc_1", seconds: 83, heard: { who: "team" }, learning: true, dropped: false });
    expect(h.mic.close).toHaveBeenCalled();
    expect(h.session.close).toHaveBeenCalled();
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.audioClose).toHaveBeenCalled();
    expect(h.timersRunning()).toBe(0);
    await h.settle();
    expect(h.calls.at(-1)!.body).toEqual({
      from: 0,
      turns: [
        { who: "vizzy", text: "Hi!", atSec: 0 },
        { who: "member", text: "Just me, a plant shop", atSec: 83 },
      ],
      notes: [{ topic: "who", choice: "team" }],
      reason: "person",
    });
    expect(h.ctl.view.ended).toMatchObject({ learning: false, heard: { who: "solo", run: "shop" } });
  });

  it("tries the end once more when learning gave nothing, and keeps the notes if it still can't", async () => {
    const h = harness({ end: { status: 502, body: { error: "learn_failed" } } });
    await talking(h);
    h.message({ toolCall: { functionCalls: [{ id: "n", name: "note_answer", args: { topic: "stage", choice: "idea" } }] } });
    h.message(heard("member", "It's only an idea"));
    h.ctl.end();
    await h.settle();
    expect(h.calls.filter((c) => c.url.endsWith("/end"))).toHaveLength(2);
    expect(h.ctl.view.ended).toMatchObject({ learning: false, heard: { stage: "idea" } });
  });

  it("ends with reason vizzy once Vizzy calls finish_call and its goodbye has played", async () => {
    const h = harness({ end: { status: 200, body: { learned: true, answers: {} } } });
    await talking(h);
    h.message(heard("member", "Thanks!"));
    h.later(5);
    h.message({ toolCall: { functionCalls: [{ id: "f", name: "finish_call", args: {} }] } });
    await h.settle();
    expect(h.player.drained).toHaveBeenCalled();
    expect(h.ctl.view.phase).toBe("ended");
    expect(h.calls.at(-1)!.body).toMatchObject({ reason: "vizzy" });
  });

  it("says the microphone was blocked, and asks for no token", async () => {
    const h = harness();
    (h.deps.askForMicrophone as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    h.ctl.start();
    await h.settle();
    expect(h.ctl.view).toMatchObject({ phase: "mic", problem: "blocked" });
    expect(h.calls).toEqual([]);
    expect(h.audioClose).toHaveBeenCalled();
  });

  it.each([
    [429, "voice_used_today", "used_today"],
    [429, "voice_starts_used", "used_today"],
    [409, "too_many_conversations", "full"],
    [503, "unavailable", "unavailable"],
    [403, "not_included", "unavailable"],
  ])("says why a call can't start (%s %s)", async (status, error, problem) => {
    const h = harness({ start: { status, body: { error } } });
    h.ctl.start();
    await h.settle();
    expect(h.ctl.view).toMatchObject({ phase: "mic", problem });
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.deps.connect).not.toHaveBeenCalled();
  });

  it("a connection that drops before anyone spoke says voice isn't available, and closes the call", async () => {
    const h = harness();
    await talking(h);
    h.message(heard("vizzy", "Hi!", true));
    h.close();
    await h.settle();
    expect(h.ctl.view).toMatchObject({ phase: "mic", problem: "unavailable" });
    expect(h.calls.at(-1)).toMatchObject({ url: "/api/admin/onboarding/conversations/oc_1/end", body: { reason: "error" } });
  });

  it("a connection that drops after they spoke ends the call, keeping what was said", async () => {
    const h = harness({ end: { status: 200, body: { learned: true, answers: { who: "solo" } } } });
    await talking(h);
    h.message(heard("member", "Just me"));
    h.close();
    await h.settle();
    expect(h.ctl.view.phase).toBe("ended");
    expect(h.ctl.view.ended).toMatchObject({ dropped: true, learning: false });
    expect(h.calls.at(-1)!.body).toMatchObject({ reason: "error", turns: [{ who: "member", text: "Just me" }] });
  });

  it("sends what's left as the page closes, with keepalive", async () => {
    const h = harness();
    await talking(h);
    h.message(heard("member", "We open in"));
    h.hidePage();
    expect(h.calls.at(-1)).toEqual({
      url: "/api/admin/onboarding/conversations/oc_1/end",
      body: { from: 0, turns: [{ who: "member", text: "We open in", atSec: 0 }], notes: [], reason: "closed" },
      keepalive: true,
    });
    expect(h.mic.close).toHaveBeenCalled();
    // Nothing after that.
    h.ctl.end();
    h.hidePage();
    expect(h.calls.filter((c) => c.url.endsWith("/end"))).toHaveLength(1);
  });

  it("leaving before the call opened stops the microphone and sends nothing", async () => {
    const h = harness();
    h.ctl.start();
    h.ctl.leave();
    await h.settle();
    expect(h.deps.connect).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(h.track.stop).toHaveBeenCalled();
  });
});
