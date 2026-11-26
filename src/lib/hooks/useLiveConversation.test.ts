import { describe, expect, it, vi } from "vitest";
import type { LiveServerMessage } from "@google/genai";
import {
  LiveConversationController,
  type LiveCallbacks,
  type LiveConversationDeps,
  type LiveSessionLike,
} from "./useLiveConversation";

// The whole waitlist voice chat with the browser faked: the audio, the microphone, reCAPTCHA,
// Gemini Live and our two routes. Nothing leaves the test.

type Reply = { status: number; body: unknown };

function harness(
  replies: Partial<Record<"token" | "complete", Reply | Reply[]>> = {},
  opts: { connect?: "open" | "pending"; micError?: string; maxDurationSeconds?: number } = {},
) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const warnings: string[] = [];
  let live: LiveCallbacks | null = null;
  let resolveConnect: ((s: LiveSessionLike) => void) | null = null;
  const mic = { start: vi.fn(), close: vi.fn() };
  // Like PcmPlayer: playing once sent audio, until it is cleared; drained() waits for that.
  const waiters: Array<() => void> = [];
  const player = {
    playing: false,
    push: vi.fn(() => {
      player.playing = true;
    }),
    clear: vi.fn(() => {
      player.playing = false;
      for (const resolve of waiters.splice(0)) resolve();
    }),
    drained: vi.fn(() => (player.playing ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve())),
  };
  const session = { sendRealtimeInput: vi.fn(), close: vi.fn() };
  const track = { stop: vi.fn() };
  const audioClose = vi.fn();
  let micChunk: ((data: string, mimeType: string) => void) | null = null;
  const queue = (k: "token" | "complete"): Reply => {
    const r = replies[k];
    if (Array.isArray(r)) return r.length > 1 ? r.shift()! : r[0]!;
    return r ?? { status: 200, body: k === "token" ? { token: "auth_tokens/t1", model: "gemini-3.8-live" } : { ok: true, bonus: 5, rank: 2 } };
  };
  const deps: LiveConversationDeps = {
    openAudio: vi.fn(() => ({
      mic: (_stream: MediaStream, onChunk: (data: string, mimeType: string) => void) => {
        micChunk = onChunk;
        return mic;
      },
      player: () => player,
      close: audioClose,
    })),
    askForMicrophone: vi.fn(async () => {
      if (opts.micError) throw Object.assign(new Error("mic"), { name: opts.micError });
      return { getTracks: () => [track] } as unknown as MediaStream;
    }),
    recaptcha: vi.fn(async () => undefined),
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> });
      const r = queue(url.endsWith("/token") ? "token" : "complete");
      return new Response(JSON.stringify(r.body), { status: r.status });
    }),
    connect: vi.fn((_token: string, _model: string, cb: LiveCallbacks) => {
      live = cb;
      if (opts.connect === "pending") return new Promise<LiveSessionLike>((resolve) => (resolveConnect = resolve));
      return Promise.resolve(session);
    }),
    after(fn, ms) {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    warn: (message) => warnings.push(message),
  };
  const ctl = new LiveConversationController(
    deps,
    () => ({ campaignId: "beta", referralToken: "REF1", maxDurationSeconds: opts.maxDurationSeconds }),
    () => {},
  );
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    ctl,
    deps,
    calls,
    warnings,
    mic,
    player,
    session,
    track,
    audioClose,
    settle,
    timers,
    message: (m: Partial<LiveServerMessage>) => live!.onmessage(m as LiveServerMessage),
    close: (code = 1000, reason = "") => live!.onclose({ code, reason }),
    error: () => live!.onerror(),
    resolveConnect: () => resolveConnect?.(session),
    speak: (data: string, mimeType: string) => micChunk?.(data, mimeType),
    completes: () => calls.filter((c) => c.url.endsWith("/complete")),
  };
}

const said = (role: "user" | "model", text: string): Partial<LiveServerMessage> => ({
  serverContent: role === "user" ? { inputTranscription: { text } } : { outputTranscription: { text } },
});

async function talking(h: ReturnType<typeof harness>) {
  h.ctl.start();
  expect(h.ctl.view.status).toBe("connecting");
  await h.settle();
  expect(h.ctl.view.status).toBe("live");
}

describe("a waitlist voice chat", () => {
  it("opens the audio inside the click, then asks for the microphone, a token, and connects", async () => {
    const h = harness();
    h.ctl.start();
    // Safari and iOS start audio only inside the click: before any await.
    expect(h.deps.openAudio).toHaveBeenCalledTimes(1);
    await h.settle();
    expect(h.deps.askForMicrophone).toHaveBeenCalledTimes(1);
    expect(h.calls[0]).toEqual({ url: "/api/waitlist/beta/conversation/token", body: { referralToken: "REF1" } });
    expect(h.deps.connect).toHaveBeenCalledWith("auth_tokens/t1", "gemini-3.8-live", expect.any(Object));
    expect(h.mic.start).toHaveBeenCalled();
    expect(h.ctl.view).toMatchObject({ status: "live", problem: null });
    // The microphone goes straight to Gemini, at the rate the capture says.
    h.speak("AAAA", "audio/pcm;rate=16000");
    expect(h.session.sendRealtimeInput).toHaveBeenCalledWith({ audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" } });
    // The safety budget: 180 seconds by default.
    expect(h.timers.map((t) => t.ms)).toEqual([180_000]);
  });

  it("writes down both sides, plays the model, and stops it when talked over", async () => {
    const h = harness();
    await talking(h);
    h.message(said("user", "Hi"));
    h.message(said("user", " there."));
    h.message(said("model", "Hello! What brought you here?"));
    expect(h.ctl.view.transcript).toEqual([
      { role: "user", text: "Hi there." },
      { role: "model", text: "Hello! What brought you here?" },
    ]);
    h.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "BBBB", mimeType: "audio/pcm;rate=24000" } }] } } });
    expect(h.player.push).toHaveBeenCalledWith("BBBB");
    expect(h.ctl.view.isModelSpeaking).toBe(true);
    h.message({ serverContent: { interrupted: true } });
    expect(h.player.clear).toHaveBeenCalled();
    expect(h.ctl.view.isModelSpeaking).toBe(false);
  });

  it("saves the chat on End and shows the boost", async () => {
    const h = harness();
    await talking(h);
    h.message(said("model", "Hi! What brought you here?"));
    h.message(said("user", "Faster invoicing."));
    h.ctl.end();
    expect(h.ctl.view.status).toBe("saving");
    await h.settle();
    expect(h.completes()).toEqual([
      {
        url: "/api/waitlist/beta/conversation/complete",
        body: {
          referralToken: "REF1",
          transcript: [
            { role: "model", text: "Hi! What brought you here?" },
            { role: "user", text: "Faster invoicing." },
          ],
        },
      },
    ]);
    expect(h.ctl.view).toMatchObject({ status: "saved", result: { bonus: 5, rank: 2 }, endedEarly: false });
    expect(h.mic.close).toHaveBeenCalled();
    expect(h.session.close).toHaveBeenCalled();
    expect(h.audioClose).toHaveBeenCalled();
    expect(h.timers[0]!.cancelled).toBe(true);
    // Our own close is expected: nothing to warn about.
    h.close(1000);
    expect(h.warnings).toEqual([]);
  });

  it("sends nothing when the person said nothing, and lets them try again", async () => {
    const h = harness();
    await talking(h);
    h.message(said("model", "Hi! What brought you here?"));
    h.message(said("user", "   "));
    h.ctl.end();
    await h.settle();
    expect(h.completes()).toEqual([]);
    expect(h.ctl.view).toMatchObject({ status: "error", problem: "nothing_heard" });
    expect(h.mic.close).toHaveBeenCalled();
    expect(h.session.close).toHaveBeenCalled();

    h.ctl.retry();
    await h.settle();
    expect(h.ctl.view.status).toBe("live");
    expect(h.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(2);
    expect(h.ctl.view.transcript).toEqual([]);
  });

  it("ends itself at the time limit, saving only when the person spoke", async () => {
    const quiet = harness({}, { maxDurationSeconds: 60 });
    await talking(quiet);
    expect(quiet.timers[0]!.ms).toBe(60_000);
    quiet.timers[0]!.fn();
    await quiet.settle();
    expect(quiet.completes()).toEqual([]);
    expect(quiet.ctl.view).toMatchObject({ status: "error", problem: "nothing_heard" });

    const chatty = harness();
    await talking(chatty);
    chatty.message(said("user", "We run a bakery."));
    chatty.timers[0]!.fn();
    await chatty.settle();
    expect(chatty.completes()).toHaveLength(1);
    expect(chatty.ctl.view.status).toBe("saved");
  });

  it("says the chat stopped when Gemini closes it before anyone spoke, and sends nothing", async () => {
    const h = harness();
    await talking(h);
    h.close(1008, "models/gemini-x is not found for API version v1alpha");
    await h.settle();
    expect(h.ctl.view).toMatchObject({ status: "error", problem: "dropped" });
    expect(h.completes()).toEqual([]);
    expect(h.mic.close).toHaveBeenCalled();
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.audioClose).toHaveBeenCalled();
    expect(h.warnings).toEqual([
      "[voice chat] Gemini ended the call (code 1008: models/gemini-x is not found for API version v1alpha)",
    ]);
  });

  it("keeps what was said when the call drops mid chat", async () => {
    const h = harness();
    await talking(h);
    h.message(said("user", "We sell plants."));
    h.error();
    h.close(1006);
    await h.settle();
    expect(h.completes()).toHaveLength(1);
    expect(h.ctl.view).toMatchObject({ status: "saved", endedEarly: true });
    // The error, then the close's code, both in the console; the chat ended once.
    expect(h.warnings).toEqual([
      "[voice chat] Gemini ended the call (connection error)",
      "[voice chat] Gemini ended the call (code 1006)",
    ]);
  });

  it("fails the start when the connection closes before it opens, and closes a late session", async () => {
    const h = harness({}, { connect: "pending" });
    h.ctl.start();
    await h.settle();
    expect(h.ctl.view.status).toBe("connecting");
    h.close(1007, "Request contains an invalid argument.");
    expect(h.ctl.view).toMatchObject({ status: "error", problem: "dropped" });
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.audioClose).toHaveBeenCalled();
    // Should the SDK still hand over a session, it is closed at once and the screen stays put.
    h.resolveConnect();
    await h.settle();
    expect(h.session.close).toHaveBeenCalled();
    expect(h.mic.start).not.toHaveBeenCalled();
    expect(h.ctl.view.status).toBe("error");
  });

  it("names why it couldn't start", async () => {
    const off = harness({ token: { status: 503, body: { error: "unavailable" } } });
    off.ctl.start();
    await off.settle();
    expect(off.ctl.view).toMatchObject({ status: "error", problem: "unavailable" });
    expect(off.track.stop).toHaveBeenCalled();
    expect(off.deps.connect).not.toHaveBeenCalled();

    const done = harness({ token: { status: 409, body: { error: "already_completed" } } });
    done.ctl.start();
    await done.settle();
    expect(done.ctl.view.problem).toBe("already_done");

    const blocked = harness({}, { micError: "NotAllowedError" });
    blocked.ctl.start();
    await blocked.settle();
    expect(blocked.ctl.view.problem).toBe("mic_blocked");
    expect(blocked.calls).toEqual([]);
    expect(blocked.audioClose).toHaveBeenCalled();

    const none = harness({}, { micError: "NotFoundError" });
    none.ctl.start();
    await none.settle();
    expect(none.ctl.view.problem).toBe("no_mic");
  });

  it("sends a chat that failed to save again on Try again, without a new call", async () => {
    const h = harness({ complete: [{ status: 500, body: { error: "boom" } }, { status: 200, body: { ok: true, bonus: 5 } }] });
    await talking(h);
    h.message(said("user", "Faster invoicing."));
    h.ctl.end();
    await h.settle();
    expect(h.ctl.view).toMatchObject({ status: "error", problem: "save_failed" });
    h.ctl.retry();
    await h.settle();
    expect(h.completes()).toHaveLength(2);
    expect(h.completes()[1]!.body.transcript).toEqual([{ role: "user", text: "Faster invoicing." }]);
    expect(h.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    expect(h.ctl.view).toMatchObject({ status: "saved", result: { bonus: 5 } });
  });

  it("shows the server's empty chat refusal as nothing heard", async () => {
    const h = harness({ complete: { status: 400, body: { error: "empty_conversation" } } });
    await talking(h);
    h.message(said("user", "Hi"));
    h.ctl.end();
    await h.settle();
    expect(h.ctl.view).toMatchObject({ status: "error", problem: "nothing_heard" });
  });

  it("stops everything when the modal closes mid call, and ignores what comes after", async () => {
    const h = harness();
    await talking(h);
    h.ctl.dispose();
    expect(h.session.close).toHaveBeenCalled();
    expect(h.mic.close).toHaveBeenCalled();
    expect(h.audioClose).toHaveBeenCalled();
    h.message(said("user", "late words"));
    h.close(1000);
    expect(h.ctl.view.transcript).toEqual([]);
    expect(h.warnings).toEqual([]);
  });

  it("starts one call at a time", async () => {
    const h = harness();
    h.ctl.start();
    h.ctl.start();
    await h.settle();
    expect(h.deps.openAudio).toHaveBeenCalledTimes(1);
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
  });
});
