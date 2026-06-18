"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GoogleGenAI,
  Modality,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import { getRecaptchaToken } from "@/lib/security/recaptchaClient";
import { appendTenantParam } from "@/lib/http/tenantParam";
import type { ConversationTurn } from "@/lib/types/signup";

/**
 * Drives the post-signup Gemini Live VOICE conversation from the browser.
 *
 * Flow: mint a locked, single-use ephemeral token from our server (proving the
 * signup via referralToken) → connect directly to Gemini with that token →
 * capture mic audio (16kHz PCM) and play model audio (24kHz PCM) → accumulate the
 * input/output transcriptions into a turn-by-turn transcript → on end, POST the
 * transcript to our server which stores it and applies the leaderboard boost.
 *
 * The per-launch system prompt is locked into the token server-side and never
 * reaches the browser. Audio plumbing mirrors the sibling app's useLiveVoice but
 * is driven by the SDK Session (ephemeral token) instead of a proxied WebSocket.
 */

export type LiveConversationStatus =
  | "idle"
  | "connecting"
  | "live"
  | "saving"
  | "saved"
  | "error";

export interface LiveConversationResult {
  bonus: number;
  rank?: number;
}

export interface UseLiveConversationOptions {
  campaignId: string;
  referralToken: string;
  /** Auto-end the conversation after this many seconds (safety budget). */
  maxDurationSeconds?: number;
}

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const PCM_BUFFER_SIZE = 4096;
const DEFAULT_MAX_DURATION = 180;

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]!));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function int16ToFloat32(int16: Int16Array): Float32Array {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i]!;
    float32[i] = v / (v < 0 ? 0x8000 : 0x7fff);
  }
  return float32;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // PCM16 is 2 bytes/sample; floor guards a stray odd byte.
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

export function useLiveConversation({
  campaignId,
  referralToken,
  maxDurationSeconds = DEFAULT_MAX_DURATION,
}: UseLiveConversationOptions) {
  const [status, setStatus] = useState<LiveConversationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<ConversationTurn[]>([]);
  const [result, setResult] = useState<LiveConversationResult | null>(null);

  const sessionRef = useRef<Session | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const transcriptRef = useRef<ConversationTurn[]>([]);
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endedRef = useRef(false);

  /** Append a transcription delta, merging consecutive same-role chunks. */
  const appendDelta = useCallback((role: "user" | "model", text: string) => {
    if (!text) return;
    const turns = transcriptRef.current;
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.text += text;
    } else {
      turns.push({ role, text });
    }
    transcriptRef.current = [...turns];
    setTranscript(transcriptRef.current);
  }, []);

  const playNextChunk = useCallback(() => {
    if (isPlayingRef.current || playbackQueueRef.current.length === 0) return;
    const chunk = playbackQueueRef.current.shift();
    if (!chunk) return;
    isPlayingRef.current = true;
    setIsModelSpeaking(true);

    let ctx = playbackCtxRef.current;
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
      playbackCtxRef.current = ctx;
    }
    const buffer = ctx.createBuffer(1, chunk.length, OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(new Float32Array(chunk), 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      isPlayingRef.current = false;
      if (playbackQueueRef.current.length > 0) playNextChunk();
      else setIsModelSpeaking(false);
    };
    source.start();
  }, []);

  const handleMessage = useCallback(
    (msg: LiveServerMessage) => {
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.inputTranscription?.text) appendDelta("user", sc.inputTranscription.text);
      if (sc.outputTranscription?.text) appendDelta("model", sc.outputTranscription.text);
      for (const part of sc.modelTurn?.parts ?? []) {
        const data = part.inlineData?.data;
        if (data && part.inlineData?.mimeType?.startsWith("audio/")) {
          playbackQueueRef.current.push(int16ToFloat32(base64ToInt16(data)));
          playNextChunk();
        }
      }
      if (sc.interrupted) {
        // Barge-in: drop queued model audio.
        playbackQueueRef.current = [];
        isPlayingRef.current = false;
        setIsModelSpeaking(false);
      }
    },
    [appendDelta, playNextChunk],
  );

  const teardownAudio = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (captureCtxRef.current) {
      captureCtxRef.current.close().catch(() => {});
      captureCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    playbackQueueRef.current = [];
    isPlayingRef.current = false;
    if (playbackCtxRef.current) {
      playbackCtxRef.current.close().catch(() => {});
      playbackCtxRef.current = null;
    }
    if (endTimerRef.current) {
      clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (status === "connecting" || status === "live") return;
    setError(null);
    setResult(null);
    transcriptRef.current = [];
    setTranscript([]);
    endedRef.current = false;
    setStatus("connecting");

    try {
      // 1. Mic (user gesture required upstream — call start() from a click).
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: INPUT_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // 2. Mint a locked ephemeral token from our server.
      const recaptchaToken = await getRecaptchaToken("conversation");
      const tokenRes = await fetch(
        appendTenantParam(`/api/waitlist/${campaignId}/conversation/token`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ referralToken, recaptchaToken }),
        },
      );
      const tokenData = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenData.token) {
        throw new Error(
          tokenRes.status === 503
            ? "The conversation isn't available right now."
            : tokenData.error === "already_completed"
              ? "You've already completed this conversation."
              : "Couldn't start the conversation.",
        );
      }

      // 3. Connect directly to Gemini with the ephemeral token.
      const ai = new GoogleGenAI({
        apiKey: tokenData.token as string,
        httpOptions: { apiVersion: "v1alpha" },
      });
      const session = await ai.live.connect({
        model: tokenData.model as string,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onmessage: handleMessage,
          onerror: () => setError("Connection error."),
          onclose: () => {},
        },
      });
      sessionRef.current = session;

      // 4. Stream mic audio as 16kHz PCM.
      const captureCtx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
      captureCtxRef.current = captureCtx;
      const src = captureCtx.createMediaStreamSource(stream);
      const processor = captureCtx.createScriptProcessor(PCM_BUFFER_SIZE, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (e) => {
        if (!sessionRef.current) return;
        const pcm16 = float32ToInt16(e.inputBuffer.getChannelData(0));
        try {
          sessionRef.current.sendRealtimeInput({
            audio: {
              data: bytesToBase64(new Uint8Array(pcm16.buffer)),
              mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
            },
          });
        } catch {
          /* session may have closed mid-flush */
        }
      };
      src.connect(processor);
      processor.connect(captureCtx.destination);

      setStatus("live");
      // Safety budget: auto-end after the max duration.
      endTimerRef.current = setTimeout(() => {
        void end();
      }, maxDurationSeconds * 1000);
    } catch (err) {
      teardownAudio();
      sessionRef.current?.close();
      sessionRef.current = null;
      setStatus("error");
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Microphone permission is needed for the conversation.");
      } else if (err instanceof Error && err.name === "NotFoundError") {
        setError("No microphone found.");
      } else {
        setError(err instanceof Error ? err.message : "Couldn't start the conversation.");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, referralToken, maxDurationSeconds, handleMessage, teardownAudio, status]);

  const end = useCallback(async () => {
    if (endedRef.current) return;
    endedRef.current = true;

    teardownAudio();
    sessionRef.current?.close();
    sessionRef.current = null;
    setIsModelSpeaking(false);
    setStatus("saving");

    try {
      const recaptchaToken = await getRecaptchaToken("conversation");
      const res = await fetch(
        appendTenantParam(`/api/waitlist/${campaignId}/conversation/complete`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            referralToken,
            transcript: transcriptRef.current,
            recaptchaToken,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "save_failed");
      setResult({ bonus: data.bonus ?? 0, rank: data.rank });
      setStatus("saved");
    } catch {
      // The conversation happened; a failed save shouldn't read as an error to
      // the user, but surface it so they can retry if they want.
      setStatus("error");
      setError("We couldn't save your conversation — please try again.");
    }
  }, [campaignId, referralToken, teardownAudio]);

  // Clean up audio/session if the component unmounts mid-call.
  useEffect(() => {
    return () => {
      teardownAudio();
      sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, [teardownAudio]);

  return { status, error, isModelSpeaking, transcript, result, start, end };
}
