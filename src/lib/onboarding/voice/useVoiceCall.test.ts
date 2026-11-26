import { describe, expect, it, vi } from "vitest";
import type { LiveServerMessage } from "@google/genai";
import { START_MESSAGE, TIME_MESSAGE } from "./transcript";
import { VoiceCallController, type LiveCallbacks, type LiveSessionLike, type VoiceCallDeps } from "./useVoiceCall";

// The whole Talk with Vizzy flow with the browser faked: the audio, the microphone, Gemini Live
// and our routes. Nothing leaves the test.

type Reply = { status: number; body: unknown };

function harness(replies: Partial<Record<"start" | "turns" | "end", Reply | Reply[]>> = {}, opts: { connect?: "open" | "pending" } = {}) {
  let now = 1_000_000;
  const calls: Array<{ url: string; body: Record<string, unknown>; keepalive?: boolean }> = [];
  const timers = new Map<number, () => void>();
  let pageHide: (() => void) | null = null;
  let live: LiveCallbacks | null = null;
  let resolveConnect: ((s: LiveSessionLike) => void) | null = null;
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
    connect: vi.fn((_token: string, _model: string, cb: LiveCallbacks) => {
      live = cb;
      // Like the SDK's live.connect: it settles only once the socket opens.
      if (opts.connect === "pending") return new Promise<LiveSessionLike>((resolve) => (resolveConnect = resolve));
      return Promise.resolve(session);
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
    error: () => live!.onerror(),
    resolveConnect: () => resolveConnect?.(session),
    ends: () => calls.filter((c) => c.url.endsWith("/end")),
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
    h.message(heard("member", "We sell plants"));
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

  it("a connection that closes before it opens ends the start as a drop, and closes the call once", async () => {
    const h = harness({}, { connect: "pending" });
    h.ctl.start();
    await h.settle();
    expect(h.deps.connect).toHaveBeenCalled();
    expect(h.ctl.view).toMatchObject({ phase: "mic", problem: null });
    // The SDK's connect never settles now: the close itself ends the start.
    h.close();
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.audioClose).toHaveBeenCalled();
    await h.settle();
    expect(h.ctl.view).toMatchObject({ phase: "mic", problem: "unavailable", ended: null });
    expect(h.ends()).toHaveLength(1);
    expect(h.ends()[0]).toMatchObject({ url: "/api/admin/onboarding/conversations/oc_1/end", body: { reason: "error", turns: [] } });
    expect(h.mic.start).not.toHaveBeenCalled();
    expect(h.timersRunning()).toBe(0);
    // And a new call can start.
    h.ctl.start();
    expect(h.ctl.view).toMatchObject({ phase: "mic", problem: null });
  });

  it("an error before the connection opens ends the start as a drop, and the close after it changes nothing", async () => {
    const h = harness({}, { connect: "pending" });
    h.ctl.start();
    await h.settle();
    h.error();
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.audioClose).toHaveBeenCalled();
    await h.settle();
    expect(h.ctl.view).toMatchObject({ phase: "mic", problem: "unavailable" });
    // A browser fires the close right after the error: the call is ended on the server once.
    h.close();
    await h.settle();
    expect(h.ends()).toHaveLength(1);
    expect(h.ends()[0]!.body).toMatchObject({ reason: "error", turns: [] });
    expect(h.ctl.view).toMatchObject({ phase: "mic", problem: "unavailable" });
  });

  it("closes a session the SDK hands over after the start ended, and leaves the screen as it is", async () => {
    const h = harness({}, { connect: "pending" });
    h.ctl.start();
    await h.settle();
    h.close();
    await h.settle();
    h.resolveConnect();
    await h.settle();
    expect(h.session.close).toHaveBeenCalled();
    expect(h.session.sendClientContent).not.toHaveBeenCalled();
    expect(h.mic.start).not.toHaveBeenCalled();
    expect(h.timersRunning()).toBe(0);
    expect(h.ctl.view).toMatchObject({ phase: "mic", problem: "unavailable" });
    expect(h.ends()).toHaveLength(1);
  });

  it("a connection that opens after a wait starts the call as before", async () => {
    const h = harness({}, { connect: "pending" });
    h.ctl.start();
    await h.settle();
    expect(h.ctl.view.phase).toBe("mic");
    h.resolveConnect();
    await h.settle();
    expect(h.ctl.view).toMatchObject({ phase: "talking", problem: null, secondsLeft: 300 });
    expect(h.session.sendClientContent).toHaveBeenCalledWith({ turns: [{ role: "user", parts: [{ text: START_MESSAGE }] }], turnComplete: true });
    expect(h.mic.start).toHaveBeenCalled();
    expect(h.session.close).not.toHaveBeenCalled();
    expect(h.ends()).toEqual([]);
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

  it("tries the end again with a wait when it fails, then shows what was learned", async () => {
    const h = harness({ end: [{ status: 500, body: {} }, { status: 429, body: { error: "rate_limited" } }, { status: 200, body: { learned: true, answers: { who: "solo" }, kept: true } }] });
    const waits: number[] = [];
    h.deps.sleep = async (ms: number) => void waits.push(ms);
    await talking(h);
    h.message(heard("member", "Just me"));
    h.ctl.end();
    await h.settle();
    expect(h.calls.filter((c) => c.url.endsWith("/end"))).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
    expect(h.ctl.view).toMatchObject({ phase: "ended", ended: { learning: false, heard: { who: "solo" } } });
  });

  it("never links to what Vizzy learned when the end didn't reach the server: the call dropped, its words so far are kept", async () => {
    const h = harness({ end: { status: 500, body: {} } });
    await talking(h);
    h.message(heard("member", "We sell plants"));
    h.ctl.end();
    await h.settle();
    expect(h.calls.filter((c) => c.url.endsWith("/end"))).toHaveLength(4);
    expect(h.ctl.view).toMatchObject({ phase: "mic", problem: "dropped", ended: null });

    // Signed out or refused: trying again won't help, so once.
    const out = harness({ end: { status: 401, body: { error: "unauthorized" } } });
    await talking(out);
    out.message(heard("member", "We sell plants"));
    out.ctl.end();
    await out.settle();
    expect(out.calls.filter((c) => c.url.endsWith("/end"))).toHaveLength(1);
    expect(out.ctl.view).toMatchObject({ phase: "mic", problem: "dropped" });
  });

  it("goes back to the welcome when End is pressed before they said anything: nothing is kept", async () => {
    const h = harness({ end: { status: 200, body: { learned: false, answers: {}, kept: false } } });
    await talking(h);
    h.message(heard("vizzy", "Hi! Tell me about your shop.", true));
    h.later(6);
    h.ctl.end();
    await h.settle();
    expect(h.calls.at(-1)).toMatchObject({ url: "/api/admin/onboarding/conversations/oc_1/end", body: { reason: "person" } });
    expect(h.ctl.view).toMatchObject({ phase: "first", ended: null, problem: null });
    // And a new call can start.
    h.ctl.start();
    expect(h.ctl.view.phase).toBe("mic");
  });

  it("shows no review when the server kept nothing from the member", async () => {
    const h = harness({ end: { status: 200, body: { learned: false, answers: {}, kept: false } } });
    await talking(h);
    h.message(heard("member", "Hello?"));
    h.ctl.end();
    await h.settle();
    expect(h.ctl.view).toMatchObject({ phase: "mic", problem: "unavailable", ended: null });
  });

  it("ends a call whose start came back after the screen went, with keepalive", async () => {
    const h = harness();
    let answer: (r: Response) => void = () => {};
    const real = h.deps.fetch;
    h.deps.fetch = vi.fn((url: string, init: RequestInit) =>
      url.endsWith("/voice/start")
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : real(url, init),
    );
    h.ctl.start();
    await h.settle();
    h.ctl.leave();
    answer(new Response(JSON.stringify({ conversationId: "oc_2", token: "tok", model: "m", callSeconds: 300 }), { status: 200 }));
    await h.settle();
    expect(h.deps.connect).not.toHaveBeenCalled();
    expect(h.calls.at(-1)).toEqual({ url: "/api/admin/onboarding/conversations/oc_2/end", body: { reason: "error" }, keepalive: true });
  });
});
