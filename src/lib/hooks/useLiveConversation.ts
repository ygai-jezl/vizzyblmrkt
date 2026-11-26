"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GoogleGenAI, Modality, type LiveServerMessage } from "@google/genai";
import { getRecaptchaToken } from "@/lib/security/recaptchaClient";
import { appendTenantParam } from "@/lib/http/tenantParam";
import type { ConversationTurn } from "@/lib/types/signup";
import { askForMicrophone, closeCallAudio, MicCapture, openCallAudio, PcmPlayer } from "@/lib/live/audio";
import {
  EMPTY_CONVERSATION,
  describeClose,
  hasUserWords,
  microphoneProblem,
  tokenProblem,
  type VoiceChatProblem,
} from "@/lib/waitlist/voiceChat";

/**
 * The post-signup Gemini Live VOICE chat on waitlist and embed pages, from the browser. In order,
 * from the click:
 *
 * 1. Both audio contexts are made and resumed inside the click (Safari and iOS start audio only
 *    there), with src/lib/live/audio.ts, the same audio Talk with Vizzy uses.
 * 2. The microphone, then a locked, single-use token from our server (the sign-up's referralToken
 *    proves who is asking), then a direct connection to Gemini Live with it. The per-launch
 *    instruction is locked into the token on the server and never reaches the browser.
 * 3. The microphone goes up as 16 kHz PCM, captured at the device's own rate and brought down
 *    (Firefox refuses to feed a microphone into a 16 kHz context). The model's voice plays with no
 *    gaps, and stops at once when the person talks over it.
 * 4. Both sides' words are written down as they come. On End, the time limit or a dropped call, the
 *    transcript goes to our server, which keeps it and applies the leaderboard boost. A chat in
 *    which the person said nothing is never sent (src/lib/waitlist/voiceChat.ts): the screen says
 *    why, and they can try again.
 *
 * Gemini closing the connection (a refused model or token, a network drop) is never silent: the
 * screen says the chat stopped, and the console names the close code and reason.
 */

export type LiveConversationStatus = "idle" | "connecting" | "live" | "saving" | "saved" | "error";

export interface LiveConversationResult {
  bonus: number;
  rank?: number;
}

export interface LiveConversationView {
  status: LiveConversationStatus;
  /** Why the chat is in "error"; the modal shows its message. */
  problem: VoiceChatProblem | null;
  isModelSpeaking: boolean;
  transcript: ConversationTurn[];
  result: LiveConversationResult | null;
  /** The call dropped after the person had spoken, and what they said was saved. */
  endedEarly: boolean;
}

export const INITIAL_CONVERSATION_VIEW: LiveConversationView = {
  status: "idle",
  problem: null,
  isModelSpeaking: false,
  transcript: [],
  result: null,
  endedEarly: false,
};

export interface UseLiveConversationOptions {
  campaignId: string;
  referralToken: string;
  /** Auto-end the conversation after this many seconds (safety budget). */
  maxDurationSeconds?: number;
}

const DEFAULT_MAX_DURATION = 180;
const JSON_HEADERS = { "Content-Type": "application/json" };

// ---- What the controller needs from the browser (faked in tests) -------------------------------

export interface MicLike {
  start(): void;
  close(): void;
}

export interface PlayerLike {
  readonly playing: boolean;
  push(base64: string): void;
  clear(): void;
  drained(): Promise<void>;
}

/** The audio contexts of one chat. */
export interface ConversationMedia {
  mic(stream: MediaStream, onChunk: (data: string, mimeType: string) => void): MicLike;
  player(): PlayerLike;
  close(): void;
}

export interface LiveSessionLike {
  sendRealtimeInput(params: { audio: { data: string; mimeType: string } }): void;
  close(): void;
}

export interface LiveCallbacks {
  onmessage(message: LiveServerMessage): void;
  onerror(): void;
  onclose(event?: { code?: number; reason?: string }): void;
}

export interface LiveConversationDeps {
  /** Both audio contexts, made and resumed at once: called inside the click. */
  openAudio(): ConversationMedia;
  askForMicrophone(): Promise<MediaStream>;
  recaptcha(action: string): Promise<string | undefined>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  connect(token: string, model: string, callbacks: LiveCallbacks): Promise<LiveSessionLike>;
  /** Run `fn` once after `ms`; returns the cancel. */
  after(fn: () => void, ms: number): () => void;
  warn(message: string): void;
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

// ---- The chat ----------------------------------------------------------------------------------

/**
 * One voice chat at a time, as a view the modal renders. Everything the browser does goes through
 * `deps`, so the whole flow runs in tests.
 */
export class LiveConversationController {
  view: LiveConversationView = INITIAL_CONVERSATION_VIEW;
  /** Bumped by each start and by leaving: anything still on its way for an older one is dropped. */
  private gen = 0;
  private busy = false;
  private ending = false;
  /** We closed the connection ourselves (End, the time limit, leaving), so its close is expected. */
  private closedByUs = false;
  private media: ConversationMedia | null = null;
  private stream: MediaStream | null = null;
  private mic: MicLike | null = null;
  private player: PlayerLike | null = null;
  private session: LiveSessionLike | null = null;
  private stopTimer: (() => void) | null = null;
  private turns: ConversationTurn[] = [];

  constructor(
    private readonly deps: LiveConversationDeps,
    private readonly options: () => UseLiveConversationOptions,
    private readonly onView: (view: LiveConversationView) => void,
  ) {}

  private set(patch: Partial<LiveConversationView>): void {
    this.view = { ...this.view, ...patch };
    this.onView(this.view);
  }

  /** Start talking: call it from the click itself. */
  start(): void {
    if (this.busy) return;
    let media: ConversationMedia;
    try {
      media = this.deps.openAudio();
    } catch {
      this.set({ ...INITIAL_CONVERSATION_VIEW, status: "error", problem: "unavailable" });
      return;
    }
    const gen = ++this.gen;
    this.busy = true;
    this.ending = false;
    this.closedByUs = false;
    this.turns = [];
    this.media = media;
    this.set({ ...INITIAL_CONVERSATION_VIEW, status: "connecting" });
    void this.open(gen);
  }

  /** Try again: send a chat that failed to save once more, or start a new one. Call it from the click. */
  retry(): void {
    if (this.busy) return;
    if (this.view.status === "error" && this.view.problem === "save_failed" && hasUserWords(this.turns)) {
      void this.save(this.gen);
      return;
    }
    this.start();
  }

  /** End: the person's button. */
  end(): void {
    void this.finish(this.gen, "person");
  }

  /** The modal closed: stop everything, and drop whatever is still on its way. */
  dispose(): void {
    this.gen += 1;
    this.closedByUs = true;
    this.closeMedia();
    this.busy = false;
  }

  private async open(gen: number): Promise<void> {
    const { campaignId, referralToken, maxDurationSeconds = DEFAULT_MAX_DURATION } = this.options();

    let stream: MediaStream;
    try {
      stream = await this.deps.askForMicrophone();
    } catch (err) {
      return this.fail(gen, microphoneProblem(err));
    }
    if (gen !== this.gen) return stopStream(stream);
    this.stream = stream;

    let started: { token: string; model: string };
    try {
      const recaptchaToken = await this.deps.recaptcha("conversation");
      const res = await this.deps.fetch(appendTenantParam(`/api/waitlist/${campaignId}/conversation/token`), {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ referralToken, recaptchaToken }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof body.token !== "string" || typeof body.model !== "string") {
        return this.fail(gen, tokenProblem(res.status, body.error));
      }
      started = { token: body.token, model: body.model };
    } catch {
      return this.fail(gen, "start_failed");
    }
    if (gen !== this.gen) return;

    // Gemini can close the connection before it is ours (a refused model or token): the SDK's
    // connect then never settles, so the close itself fails the start (see lost).
    let session: LiveSessionLike;
    try {
      session = await this.deps.connect(started.token, started.model, {
        onmessage: (message) => this.onMessage(gen, message),
        onerror: () => this.lost(gen, "connection error"),
        onclose: (event) => this.lost(gen, describeClose(event)),
      });
    } catch {
      if (gen === this.gen && this.view.status === "connecting") this.deps.warn("[voice chat] couldn't connect to Gemini Live");
      return this.fail(gen, "start_failed");
    }
    if (gen !== this.gen || this.view.status !== "connecting" || !this.media) {
      try {
        session.close();
      } catch {
        /* already closed */
      }
      return;
    }

    this.session = session;
    this.player = this.media.player();
    this.mic = this.media.mic(stream, (data, mimeType) => {
      try {
        this.session?.sendRealtimeInput({ audio: { data, mimeType } });
      } catch {
        /* closing */
      }
    });
    this.mic.start();
    this.set({ status: "live" });
    // Safety budget: the chat ends itself after the max duration.
    this.stopTimer = this.deps.after(() => void this.finish(gen, "time"), maxDurationSeconds * 1000);
  }

  private fail(gen: number, problem: VoiceChatProblem): void {
    if (gen !== this.gen) return;
    this.closeMedia();
    this.busy = false;
    this.set({ status: "error", problem, isModelSpeaking: false });
  }

  /** Gemini closed or broke the connection, which we expect only after closing it ourselves. */
  private lost(gen: number, why: string): void {
    if (gen !== this.gen || this.closedByUs) return;
    this.deps.warn(`[voice chat] Gemini ended the call (${why})`);
    if (this.view.status === "connecting") this.fail(gen, "dropped");
    else if (this.view.status === "live") void this.finish(gen, "dropped");
  }

  private onMessage(gen: number, msg: LiveServerMessage): void {
    if (gen !== this.gen || this.ending || this.view.status !== "live") return;
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) this.add("user", sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.add("model", sc.outputTranscription.text);
    for (const part of sc.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data && part.inlineData?.mimeType?.startsWith("audio/")) this.play(gen, data);
    }
    if (sc.interrupted) {
      // Barge-in: the person talked over the model, so drop what it was still going to say.
      this.player?.clear();
      if (this.view.isModelSpeaking) this.set({ isModelSpeaking: false });
    }
  }

  /** A transcription piece, joined to the turn before when the same side is still talking. */
  private add(role: ConversationTurn["role"], text: string): void {
    const last = this.turns[this.turns.length - 1];
    this.turns =
      last && last.role === role
        ? [...this.turns.slice(0, -1), { role, text: last.text + text }]
        : [...this.turns, { role, text }];
    this.set({ transcript: this.turns });
  }

  private play(gen: number, data: string): void {
    const player = this.player;
    if (!player) return;
    player.push(data);
    if (!this.view.isModelSpeaking && player.playing) {
      this.set({ isModelSpeaking: true });
      this.watchSpeaking(gen, player);
    }
  }

  /** "Speaking" until the player has said everything it was sent. */
  private watchSpeaking(gen: number, player: PlayerLike): void {
    void player.drained().then(() => {
      if (gen !== this.gen || this.player !== player) return;
      if (player.playing) return this.watchSpeaking(gen, player);
      if (this.view.isModelSpeaking) this.set({ isModelSpeaking: false });
    });
  }

  private async finish(gen: number, why: "person" | "time" | "dropped"): Promise<void> {
    if (gen !== this.gen || this.ending || this.view.status !== "live") return;
    this.ending = true;
    if (why !== "dropped") this.closedByUs = true;
    this.closeMedia();
    // Nothing said: nothing is sent, so the sign-up keeps its one chat and can try again.
    if (!hasUserWords(this.turns)) {
      this.busy = false;
      this.set({ status: "error", problem: why === "dropped" ? "dropped" : "nothing_heard", isModelSpeaking: false });
      return;
    }
    this.set({ endedEarly: why === "dropped", isModelSpeaking: false });
    await this.save(gen);
  }

  /** The transcript to our server, which keeps it and applies the boost once. */
  private async save(gen: number): Promise<void> {
    const { campaignId, referralToken } = this.options();
    this.busy = true;
    this.set({ status: "saving", problem: null });
    let problem: VoiceChatProblem = "save_failed";
    try {
      const recaptchaToken = await this.deps.recaptcha("conversation");
      const res = await this.deps.fetch(appendTenantParam(`/api/waitlist/${campaignId}/conversation/complete`), {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ referralToken, transcript: this.turns, recaptchaToken }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        if (gen !== this.gen) return;
        this.busy = false;
        const bonus = typeof data.bonus === "number" ? data.bonus : 0;
        this.set({ status: "saved", result: typeof data.rank === "number" ? { bonus, rank: data.rank } : { bonus } });
        return;
      }
      if (data.error === EMPTY_CONVERSATION) problem = "nothing_heard";
    } catch {
      /* offline for a moment: Try again sends it once more */
    }
    if (gen !== this.gen) return;
    this.busy = false;
    this.set({ status: "error", problem });
  }

  private closeMedia(): void {
    this.stopTimer?.();
    this.stopTimer = null;
    this.mic?.close();
    this.mic = null;
    stopStream(this.stream);
    this.stream = null;
    this.player?.clear();
    this.player = null;
    const session = this.session;
    this.session = null;
    try {
      session?.close();
    } catch {
      /* already closed */
    }
    this.media?.close();
    this.media = null;
  }
}

// ---- The browser -------------------------------------------------------------------------------

/** A Live session on the chat's token. The token's config is locked on the server; this only names what the browser expects. */
async function connectLive(token: string, model: string, callbacks: LiveCallbacks): Promise<LiveSessionLike> {
  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
  return ai.live.connect({ model, config: { responseModalities: [Modality.AUDIO] }, callbacks });
}

function browserDeps(): LiveConversationDeps {
  return {
    openAudio() {
      const audio = openCallAudio();
      return {
        mic: (stream, onChunk) => new MicCapture(audio.capture, stream, onChunk),
        player: () => new PcmPlayer(audio.playback),
        close: () => closeCallAudio(audio),
      };
    },
    askForMicrophone,
    recaptcha: getRecaptchaToken,
    fetch: (url, init) => fetch(url, init),
    connect: connectLive,
    after(fn, ms) {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    warn: (message) => console.warn(message),
  };
}

/** The waitlist voice chat for ConversationModal. Closing the modal mid call stops it. */
export function useLiveConversation({ campaignId, referralToken, maxDurationSeconds }: UseLiveConversationOptions) {
  const [view, setView] = useState<LiveConversationView>(INITIAL_CONVERSATION_VIEW);
  const options = useRef<UseLiveConversationOptions>({ campaignId, referralToken, maxDurationSeconds });
  const controller = useRef<LiveConversationController | null>(null);
  if (!controller.current) controller.current = new LiveConversationController(browserDeps(), () => options.current, setView);
  useEffect(() => {
    options.current = { campaignId, referralToken, maxDurationSeconds };
  }, [campaignId, referralToken, maxDurationSeconds]);
  useEffect(() => {
    const c = controller.current;
    return () => c?.dispose();
  }, []);
  const controls = useMemo(
    () => ({
      start: () => controller.current?.start(),
      retry: () => controller.current?.retry(),
      end: () => controller.current?.end(),
    }),
    [],
  );
  return { ...view, ...controls };
}
