/**
 * PCM helpers for the Gemini Live voice calls in the browser: the voice chat on waitlist pages
 * (src/lib/hooks/useLiveConversation.ts) and Talk with Vizzy (src/lib/onboarding/voice/useVoiceCall.ts).
 * Live takes 16-bit little-endian PCM in base64 and answers with 24 kHz PCM the same way.
 * Pure and client safe.
 */

/** Float samples (-1 to 1) as 16-bit PCM. */
export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]!));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

/** 16-bit PCM as float samples (-1 to 1). */
export function int16ToFloat32(int16: Int16Array): Float32Array {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i]!;
    float32[i] = v / (v < 0 ? 0x8000 : 0x7fff);
  }
  return float32;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // PCM16 is 2 bytes/sample; floor guards a stray odd byte.
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

/**
 * Mono samples taken at `fromRate`, at the lower `toRate`: each output sample is the mean of the
 * input samples it covers. A rate that is already low enough comes back as it is. Talk with Vizzy
 * captures at the microphone's own rate (some browsers refuse a 16 kHz microphone) and sends 16 kHz.
 */
export function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > toRate) || !(toRate > 0)) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}
