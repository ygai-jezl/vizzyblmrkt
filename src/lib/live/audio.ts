"use client";

import { base64ToInt16, bytesToBase64, downsample, float32ToInt16, int16ToFloat32 } from "./pcm";

/**
 * The browser's side of a Gemini Live voice call, for Talk with Vizzy
 * (src/lib/onboarding/voice/useVoiceCall.ts) and the voice chat on waitlist pages
 * (src/lib/hooks/useLiveConversation.ts): the microphone, sent as 16 kHz PCM, and the model's
 * voice, played as it arrives with no gaps. Browser only.
 */

/** What Live hears best: 16 kHz mono. */
export const SEND_RATE = 16_000;
/** What Live speaks: 24 kHz mono. */
export const PLAY_RATE = 24_000;
const FRAMES = 4096;

export interface CallAudio {
  capture: AudioContext;
  playback: AudioContext;
}

/**
 * Both audio contexts, made and resumed at once. Call it inside the click, before any await:
 * Safari and iOS start audio only inside a gesture. The capture context runs at the device's own
 * rate (some browsers refuse a 16 kHz one for a microphone) and MicCapture brings it down.
 */
export function openCallAudio(): CallAudio {
  const capture = new AudioContext();
  const playback = new AudioContext({ sampleRate: PLAY_RATE });
  void capture.resume().catch(() => {});
  void playback.resume().catch(() => {});
  return { capture, playback };
}

export function closeCallAudio(audio: CallAudio | null): void {
  if (!audio) return;
  for (const ctx of [audio.capture, audio.playback]) if (ctx.state !== "closed") void ctx.close().catch(() => {});
}

/** The microphone, mono, with the browser's echo cancelling (the model's voice plays from the same device). */
export function askForMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

/**
 * The microphone as base64 PCM chunks of about a tenth of a second, at 16 kHz (or the device's
 * rate when that is lower). Muted, nothing is sent and the track itself is off.
 */
export class MicCapture {
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private muted = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly stream: MediaStream,
    private readonly onChunk: (data: string, mimeType: string) => void,
  ) {}

  start(): void {
    if (this.processor) return;
    const rate = Math.min(SEND_RATE, this.ctx.sampleRate);
    const mimeType = `audio/pcm;rate=${rate}`;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(FRAMES, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (this.muted) return;
      const pcm = float32ToInt16(downsample(e.inputBuffer.getChannelData(0), this.ctx.sampleRate, rate));
      if (pcm.length) this.onChunk(bytesToBase64(new Uint8Array(pcm.buffer)), mimeType);
    };
    // A processor runs only when it is connected on to the output; the gain keeps it silent.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.ctx.destination);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.stream.getAudioTracks()) track.enabled = !muted;
  }

  /** Stop the microphone for good (the browser's recording light goes off). */
  close(): void {
    if (this.processor) this.processor.onaudioprocess = null;
    for (const node of [this.source, this.processor, this.sink]) {
      try {
        node?.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.source = this.processor = this.sink = null;
    for (const track of this.stream.getTracks()) track.stop();
  }
}

/**
 * The model's voice: each chunk is scheduled right after the one before, so there are no gaps.
 * `clear()` stops it at once (the person talked over it); `drained()` waits until it has said
 * everything it was sent.
 */
export class PcmPlayer {
  private next = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private waiters: Array<() => void> = [];

  constructor(private readonly ctx: AudioContext) {}

  get playing(): boolean {
    return this.sources.size > 0;
  }

  push(base64: string): void {
    if (this.ctx.state === "closed") return;
    const samples = int16ToFloat32(base64ToInt16(base64));
    if (!samples.length) return;
    const buffer = this.ctx.createBuffer(1, samples.length, PLAY_RATE);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime, this.next);
    source.onended = () => {
      this.sources.delete(source);
      if (!this.sources.size) this.settle();
    };
    this.sources.add(source);
    source.start(at);
    this.next = at + buffer.duration;
  }

  clear(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* not started yet, or already stopped */
      }
    }
    this.sources.clear();
    this.next = 0;
    this.settle();
  }

  drained(): Promise<void> {
    if (!this.sources.size) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private settle(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }
}
