"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FunctionResponseScheduling, LiveServerMessage } from "@google/genai";
import { askForMicrophone, closeCallAudio, MicCapture, openCallAudio, PcmPlayer } from "@/lib/live/audio";
import type { ProfileKey } from "@/lib/types/businessProfile";
import { ONBOARDING_LIMITS, type EndReason, type VoiceNote } from "@/lib/types/onboarding";
import { notedAnswers, topicStates, validNote, type TopicView } from "./topics";
import {
  EMPTY_TRANSCRIPT,
  FLUSH_MS,
  GOODBYE_MS,
  START_MESSAGE,
  TIME_MESSAGE,
  WRAP_UP_AT,
  addPiece,
  finishLine,
  nextUpload,
  turnsForUpload,
  type Transcript,
} from "./transcript";

/**
 * Talk with Vizzy from the browser (ONBOARDING_VOICE_ENABLED). In order, from the click:
 *
 * 1. Both audio contexts are made and resumed inside the click (Safari starts audio only there).
 * 2. The microphone, then POST /api/admin/onboarding/voice/start for a locked, single-use token,
 *    then a direct connection to Gemini Live with it (the instruction never reaches the browser).
 * 3. "[Start]" asks Vizzy to say hello; the 5 minutes count from the open connection; "[Time]"
 *    goes with a minute left; at 0 the call ends.
 * 4. Finished lines go up every 5 seconds (.../turns); the end sends the rest (.../end), which
 *    learns from the call. A closing page sends what's left with keepalive.
 *
 * Vizzy's silent note_answer calls tick the topics; finish_call ends the call once its goodbye
 * has played. The call's seconds are counted by the server, not here.
 */

export type VoicePhase = "first" | "mic" | "talking" | "ended";
/**
 * Why a call couldn't start, stopped before anyone spoke, or (`dropped`) ended without the server
 * hearing of it: what was sent before is kept, and there is nothing to review yet.
 */
export type VoiceProblem = "blocked" | "used_today" | "full" | "unavailable" | "dropped";

export interface EndedCall {
  conversationId: string;
  /** The call's length by the clock on screen. */
  seconds: number;
  /** What Vizzy heard, by topic: the notes at first, what the server learned once it has. */
  heard: Partial<Record<ProfileKey, string>>;
  /** The end is still being sent and learned from. */
  learning: boolean;
  /** The connection dropped (what was said is kept). */
  dropped: boolean;
}

export interface VoiceCallView {
  phase: VoicePhase;
  problem: VoiceProblem | null;
  muted: boolean;
  callSeconds: number;
  secondsLeft: number;
  topics: TopicView[];
  transcript: Transcript;
  ended: EndedCall | null;
}

export interface VoiceCallControls {
  start(): void;
  end(): void;
  toggleMute(): void;
}

export type VoiceCall = VoiceCallView & VoiceCallControls;

const CALL_SECONDS = 300;

export const INITIAL_VOICE_VIEW: VoiceCallView = {
  phase: "first",
  problem: null,
  muted: false,
  callSeconds: CALL_SECONDS,
  secondsLeft: CALL_SECONDS,
  topics: topicStates([]),
  transcript: EMPTY_TRANSCRIPT,
  ended: null,
};

// ---- What the controller needs from the browser (faked in tests) -------------------------------

export interface MicLike {
  start(): void;
  setMuted(muted: boolean): void;
  close(): void;
}

export interface PlayerLike {
  readonly playing: boolean;
  push(base64: string): void;
  clear(): void;
  drained(): Promise<void>;
}

/** The audio contexts of one call. */
export interface CallMedia {
  mic(stream: MediaStream, onChunk: (data: string, mimeType: string) => void): MicLike;
  player(): PlayerLike;
  close(): void;
}

export interface LiveSessionLike {
  sendClientContent(params: { turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: boolean }): void;
  sendRealtimeInput(params: { audio?: { data: string; mimeType: string }; text?: string; audioStreamEnd?: boolean }): void;
  sendToolResponse(params: {
    functionResponses: Array<{ id?: string; name?: string; response: Record<string, unknown>; scheduling: FunctionResponseScheduling }>;
  }): void;
  close(): void;
}

export interface LiveCallbacks {
  onmessage(message: LiveServerMessage): void;
  onerror(): void;
  onclose(): void;
}

export interface VoiceCallDeps {
  openAudio(): CallMedia;
  askForMicrophone(): Promise<MediaStream>;
  connect(token: string, model: string, callbacks: LiveCallbacks): Promise<LiveSessionLike>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  /** Run `fn` every `ms`; returns the stop. */
  every(fn: () => void, ms: number): () => void;
  sleep(ms: number): Promise<void>;
  /** Run `fn` when the page goes away; returns the removal. */
  onPageHide(fn: () => void): () => void;
}

// ---- The call --------------------------------------------------------------------------------------

const API = "/api/admin/onboarding";
const JSON_HEADERS = { "content-type": "application/json" };
const SILENT = "SILENT" as FunctionResponseScheduling;
/** Quiet this long after Vizzy's last sound counts as its goodbye being over. */
const QUIET_MS = 1_200;
/** Tries at sending the end, waiting 1, 2 then 4 seconds between them. Ending again is safe. */
const END_TRIES = 4;
const END_WAIT_MS = 1_000;

/** What the end of a call came to on the server. */
interface EndResult {
  /** The member's words are kept (false: the member never spoke, so the server didn't keep it). */
  kept: boolean;
  learned: boolean;
  heard: Partial<Record<ProfileKey, string>>;
}

function problemFor(status: number, error: unknown): VoiceProblem {
  if (error === "voice_used_today" || error === "voice_starts_used") return "used_today";
  if (error === "too_many_conversations") return "full";
  return status === 429 ? "used_today" : "unavailable";
}

const isBlocked = (err: unknown) => err instanceof Error && (err.name === "NotAllowedError" || err.name === "SecurityError");

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function heardFrom(raw: unknown): Partial<Record<ProfileKey, string>> {
  const out: Partial<Record<ProfileKey, string>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const note = validNote({ topic: k, choice: v });
    if (note && note.choice !== "unclear") out[note.topic] = note.choice;
  }
  return out;
}

/**
 * One Talk with Vizzy call at a time, as a view the screen renders. Everything the browser does
 * goes through `deps`, so the whole flow runs in tests.
 */
export class VoiceCallController {
  view: VoiceCallView = INITIAL_VOICE_VIEW;
  private gen = 0;
  private busy = false;
  private media: CallMedia | null = null;
  private stream: MediaStream | null = null;
  private mic: MicLike | null = null;
  private player: PlayerLike | null = null;
  private session: LiveSessionLike | null = null;
  private conversationId: string | null = null;
  private callSeconds = CALL_SECONDS;
  private openedAt = 0;
  private lastSoundAt = 0;
  private notes: VoiceNote[] = [];
  private sentTurns = 0;
  private sentNotes = 0;
  private uploading: Promise<void> | null = null;
  private uploadsStopped = false;
  private warned = false;
  private ending = false;
  private stops: Array<() => void> = [];

  constructor(
    private readonly deps: VoiceCallDeps,
    private readonly onView: (view: VoiceCallView) => void,
  ) {}

  private set(patch: Partial<VoiceCallView>): void {
    this.view = { ...this.view, ...patch };
    this.onView(this.view);
  }

  /** Talk with Vizzy: call it from the click itself. */
  start(): void {
    if (this.busy) return;
    let media: CallMedia;
    try {
      media = this.deps.openAudio();
    } catch {
      this.set({ phase: "mic", problem: "unavailable" });
      return;
    }
    this.reset();
    this.busy = true;
    this.media = media;
    const gen = ++this.gen;
    this.set({ ...INITIAL_VOICE_VIEW, phase: "mic" });
    void this.open(gen);
  }

  private reset(): void {
    this.conversationId = null;
    this.callSeconds = CALL_SECONDS;
    this.openedAt = 0;
    this.lastSoundAt = 0;
    this.notes = [];
    this.sentTurns = 0;
    this.sentNotes = 0;
    this.uploading = null;
    this.uploadsStopped = false;
    this.warned = false;
    this.ending = false;
  }

  private async open(gen: number): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await this.deps.askForMicrophone();
    } catch (err) {
      return this.refuse(gen, isBlocked(err) ? "blocked" : "unavailable");
    }
    if (gen !== this.gen) return stopStream(stream);
    this.stream = stream;

    let started: { conversationId: string; token: string; model: string; callSeconds?: number };
    try {
      const res = await this.deps.fetch(`${API}/voice/start`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof body.token !== "string" || typeof body.conversationId !== "string" || typeof body.model !== "string") {
        return this.refuse(gen, problemFor(res.status, body.error));
      }
      started = body as typeof started;
    } catch {
      return this.refuse(gen, "unavailable");
    }
    // The screen went while the start was on its way (Back, a link): end the call it made at once.
    if (gen !== this.gen) return this.endUnused(started.conversationId);
    this.conversationId = started.conversationId;
    const seconds = Number(started.callSeconds);
    this.callSeconds = Number.isFinite(seconds) ? Math.min(600, Math.max(30, Math.floor(seconds))) : CALL_SECONDS;

    // A connection that closes before it is ours (a refused token, no model) is a failed start.
    let closedEarly = false;
    const lost = () => {
      if (this.openedAt) this.dropped(gen);
      else closedEarly = true;
    };
    let session: LiveSessionLike | null = null;
    try {
      session = await this.deps.connect(started.token, started.model, { onmessage: (m) => this.onMessage(gen, m), onerror: lost, onclose: lost });
    } catch {
      closedEarly = true;
    }
    if (gen !== this.gen) return void session?.close();
    if (closedEarly || !session) {
      session?.close();
      // Nothing was said: close the conversation now rather than at the brand's next start.
      void this.sendEnd("error");
      return this.refuse(gen, "unavailable");
    }
    this.session = session;
    this.openedAt = this.deps.now();
    try {
      session.sendClientContent({ turns: [{ role: "user", parts: [{ text: START_MESSAGE }] }], turnComplete: true });
    } catch {
      /* the close callback says so */
    }
    this.player = this.media!.player();
    this.mic = this.media!.mic(stream, (data, mimeType) => {
      try {
        this.session?.sendRealtimeInput({ audio: { data, mimeType } });
      } catch {
        /* closing */
      }
    });
    this.mic.start();
    this.set({ phase: "talking", callSeconds: this.callSeconds, secondsLeft: this.callSeconds });
    this.stops.push(
      this.deps.every(() => this.tick(gen), 1_000),
      this.deps.every(() => void this.flush(), FLUSH_MS),
      this.deps.onPageHide(() => this.leave()),
    );
  }

  private refuse(gen: number, problem: VoiceProblem): void {
    if (gen !== this.gen) return;
    this.closeMedia();
    this.busy = false;
    this.set({ phase: "mic", problem });
  }

  private elapsed(): number {
    return this.openedAt ? Math.max(0, Math.floor((this.deps.now() - this.openedAt) / 1000)) : 0;
  }

  private tick(gen: number): void {
    if (gen !== this.gen || this.ending) return;
    const left = Math.max(0, this.callSeconds - this.elapsed());
    if (left !== this.view.secondsLeft) this.set({ secondsLeft: left });
    if (left <= WRAP_UP_AT && !this.warned) {
      this.warned = true;
      try {
        this.session?.sendRealtimeInput({ text: TIME_MESSAGE });
      } catch {
        /* closing */
      }
    }
    if (left <= 0) void this.finish("time");
  }

  private onMessage(gen: number, msg: LiveServerMessage): void {
    if (gen !== this.gen || this.ending) return;
    const sc = msg.serverContent;
    if (sc) {
      const at = this.elapsed();
      let t = this.view.transcript;
      if (sc.inputTranscription?.text) t = addPiece(t, "member", sc.inputTranscription.text, at);
      if (sc.outputTranscription?.text) t = addPiece(t, "vizzy", sc.outputTranscription.text, at);
      for (const part of sc.modelTurn?.parts ?? []) {
        const data = part.inlineData?.data;
        if (data && part.inlineData?.mimeType?.startsWith("audio/")) {
          this.player?.push(data);
          this.lastSoundAt = this.deps.now();
        }
      }
      if (sc.interrupted) this.player?.clear();
      const finished =
        sc.turnComplete ||
        (sc.inputTranscription?.finished && t.partial?.who === "member") ||
        (sc.outputTranscription?.finished && t.partial?.who === "vizzy");
      if (finished) t = finishLine(t);
      if (t !== this.view.transcript) this.set({ transcript: t });
    }

    const calls = msg.toolCall?.functionCalls ?? [];
    if (calls.length) {
      let finishing = false;
      for (const call of calls) {
        if (call.name === "note_answer") {
          const note = validNote(call.args);
          if (note && this.notes.length < 100) this.notes.push(note);
        } else if (call.name === "finish_call") {
          finishing = true;
        }
      }
      this.set({ topics: topicStates(this.notes) });
      try {
        this.session?.sendToolResponse({
          functionResponses: calls.map((c) => ({ id: c.id, name: c.name, response: { ok: true }, scheduling: SILENT })),
        });
      } catch {
        /* closing */
      }
      if (finishing) void this.goodbye(gen);
    }
    if (msg.goAway) void this.finish("closed");
  }

  /** finish_call: let the goodbye play out (never more than 10 seconds), then end. */
  private async goodbye(gen: number): Promise<void> {
    const deadline = this.deps.now() + GOODBYE_MS;
    while (gen === this.gen && !this.ending && this.deps.now() < deadline) {
      await Promise.race([this.player?.drained() ?? Promise.resolve(), this.deps.sleep(Math.max(0, deadline - this.deps.now()))]);
      if (!this.player?.playing && this.deps.now() - this.lastSoundAt >= QUIET_MS) break;
      await this.deps.sleep(300);
    }
    if (gen === this.gen) await this.finish("vizzy");
  }

  private dropped(gen: number): void {
    if (gen !== this.gen || this.ending) return;
    void this.finish("error", true);
  }

  toggleMute(): void {
    if (this.view.phase !== "talking" || this.ending) return;
    const muted = !this.view.muted;
    this.mic?.setMuted(muted);
    if (muted) {
      try {
        this.session?.sendRealtimeInput({ audioStreamEnd: true });
      } catch {
        /* closing */
      }
    }
    this.set({ muted });
  }

  /** End: the person's button. */
  end(): void {
    if (this.view.phase === "talking") void this.finish("person");
  }

  /** Send finished lines the server doesn't have yet (one upload at a time). */
  private flush(): Promise<void> {
    if (this.uploading) return this.uploading;
    const p = this.upload().finally(() => {
      this.uploading = null;
    });
    this.uploading = p;
    return p;
  }

  private async upload(): Promise<void> {
    if (!this.conversationId || this.uploadsStopped) return;
    const turns = turnsForUpload(this.view.transcript.lines);
    const notes = this.notes.length;
    const batch = nextUpload(turns, this.sentTurns, this.notes.slice(this.sentNotes));
    if (!batch.turns.length) return;
    try {
      const res = await this.deps.fetch(`${API}/conversations/${this.conversationId}/turns`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(batch),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const length = typeof body.length === "number" && body.length >= 0 ? Math.min(body.length, turns.length) : null;
      if (res.ok && length !== null) {
        this.sentTurns = length;
        this.sentNotes = notes;
      } else if (res.status === 409 && body.error === "out_of_order" && length !== null) {
        this.sentTurns = length;
      } else if (res.status !== 429 && res.status < 500) {
        // Closed, full or not this person's: nothing more will be taken.
        this.uploadsStopped = true;
      }
    } catch {
      /* offline for a moment: the next flush tries again */
    }
  }

  /** A call started for a screen that has gone: ended now, as the page may be closing, so it is never left open. */
  private endUnused(conversationId: string): void {
    try {
      void this.deps
        .fetch(`${API}/conversations/${conversationId}/end`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ reason: "error" }), keepalive: true })
        .catch(() => {});
    } catch {
      /* the page is gone */
    }
  }

  /**
   * The rest of the words and the end, which learns. A failed try (offline, a limit, the server)
   * is tried again, up to 4 times; ending again is safe. Learning that gave nothing (502
   * learn_failed) is tried once more, and the call is ended and kept either way. Null when the end
   * never reached the server: the call is still open there, with the words sent before.
   */
  private async sendEnd(reason: EndReason): Promise<EndResult | null> {
    if (!this.conversationId) return null;
    const upload = nextUpload(turnsForUpload(this.view.transcript.lines), this.sentTurns, this.notes.slice(this.sentNotes));
    const body = JSON.stringify(this.uploadsStopped ? { reason } : { ...upload, reason });
    let learnTried = false;
    for (let attempt = 0; attempt < END_TRIES; attempt += 1) {
      if (attempt > 0) await this.deps.sleep(END_WAIT_MS * 2 ** (attempt - 1));
      try {
        const res = await this.deps.fetch(`${API}/conversations/${this.conversationId}/end`, { method: "POST", headers: JSON_HEADERS, body });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.ok) return { kept: data.kept !== false, learned: data.learned === true, heard: heardFrom(data.answers) };
        if (res.status === 502 && data.error === "learn_failed") {
          if (learnTried) return { kept: true, learned: false, heard: {} };
          learnTried = true;
          continue;
        }
        // Signed out, refused or gone: trying again won't change it.
        if (res.status !== 429 && res.status < 500) return null;
      } catch {
        /* offline for a moment: try again */
      }
    }
    return null;
  }

  private async finish(reason: EndReason, dropped = false): Promise<void> {
    if (this.ending || !this.conversationId) return;
    this.ending = true;
    const seconds = Math.min(this.callSeconds, this.elapsed());
    this.closeMedia();
    const transcript = finishLine(this.view.transcript);
    const spoke = transcript.lines.some((l) => l.who === "member");
    this.set({ transcript });

    // Nothing said: nothing is kept (the server deletes a call with no words from the member), so
    // a dropped call says voice isn't available, and any other end goes back to the welcome.
    if (!spoke) {
      await this.sendEnd(dropped ? "error" : reason);
      this.busy = false;
      this.set(dropped ? { phase: "mic", problem: "unavailable" } : { ...INITIAL_VOICE_VIEW });
      return;
    }

    const conversationId = this.conversationId;
    this.set({ phase: "ended", ended: { conversationId, seconds, heard: notedAnswers(this.notes), learning: true, dropped } });
    // Words still to send beyond one upload go first.
    await this.uploading;
    for (let i = 0; i < 12 && !this.uploadsStopped; i += 1) {
      const left = turnsForUpload(transcript.lines).length - this.sentTurns;
      if (left <= ONBOARDING_LIMITS.TURNS_PER_APPEND) break;
      const before = this.sentTurns;
      await this.flush();
      if (this.sentTurns === before) break;
    }
    const result = await this.sendEnd(reason);
    this.busy = false;
    // No review without an end the server has: the call dropped, its words so far are kept. And
    // none when the server kept nothing from the member.
    if (!result || !result.kept) {
      this.set({ phase: "mic", problem: result ? "unavailable" : "dropped", ended: null });
      return;
    }
    const ended = this.view.ended!;
    this.set({ ended: { ...ended, learning: false, heard: result.learned ? result.heard : ended.heard } });
  }

  /** The page is going away mid call: send what's left as it closes, and stop everything. */
  leave(): void {
    this.gen += 1;
    if (!this.conversationId || this.ending) {
      this.closeMedia();
      this.busy = false;
      return;
    }
    this.ending = true;
    this.closeMedia();
    const transcript = finishLine(this.view.transcript);
    const upload = nextUpload(turnsForUpload(transcript.lines), this.sentTurns, this.notes.slice(this.sentNotes));
    try {
      void this.deps
        .fetch(`${API}/conversations/${this.conversationId}/end`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(this.uploadsStopped ? { reason: "closed" } : { ...upload, reason: "closed" }),
          keepalive: true,
        })
        .catch(() => {});
    } catch {
      /* the page is gone */
    }
  }

  private closeMedia(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.mic?.close();
    this.mic = null;
    stopStream(this.stream);
    this.stream = null;
    this.player?.clear();
    this.player = null;
    try {
      this.session?.close();
    } catch {
      /* already closed */
    }
    this.session = null;
    this.media?.close();
    this.media = null;
  }
}

// ---- The browser -----------------------------------------------------------------------------------

/** A Live session on the call's token. The SDK loads only when a call starts. */
async function connectLive(token: string, model: string, callbacks: LiveCallbacks): Promise<LiveSessionLike> {
  const { GoogleGenAI, Modality } = await import("@google/genai");
  // The token's own config is locked on the server; this only names what the browser expects.
  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
  return ai.live.connect({ model, config: { responseModalities: [Modality.AUDIO] }, callbacks });
}

function browserDeps(): VoiceCallDeps {
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
    connect: connectLive,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    every(fn, ms) {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onPageHide(fn) {
      window.addEventListener("pagehide", fn);
      return () => window.removeEventListener("pagehide", fn);
    },
  };
}

/** Talk with Vizzy for the welcome screen. Leaving the page mid call ends it. */
export function useVoiceCall(): VoiceCall {
  const [view, setView] = useState<VoiceCallView>(INITIAL_VOICE_VIEW);
  const controller = useRef<VoiceCallController | null>(null);
  if (!controller.current) controller.current = new VoiceCallController(browserDeps(), setView);
  useEffect(() => {
    const c = controller.current;
    return () => c?.leave();
  }, []);
  const controls = useMemo<VoiceCallControls>(
    () => ({
      start: () => controller.current?.start(),
      end: () => controller.current?.end(),
      toggleMute: () => controller.current?.toggleMute(),
    }),
    [],
  );
  return { ...view, ...controls };
}
