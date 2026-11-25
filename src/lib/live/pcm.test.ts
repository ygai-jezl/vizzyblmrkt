import { describe, expect, it } from "vitest";
import { base64ToInt16, bytesToBase64, downsample, float32ToInt16, int16ToFloat32 } from "./pcm";

describe("PCM for Gemini Live", () => {
  it("turns float samples into 16-bit PCM, clamping anything out of range", () => {
    expect([...float32ToInt16(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -3]))]).toEqual([0, 32767, -32768, 16383, -16384, 32767, -32768]);
  });

  it("turns 16-bit PCM back into float samples", () => {
    const back = int16ToFloat32(new Int16Array([0, 32767, -32768, 16384]));
    expect(back[0]).toBe(0);
    expect(back[1]).toBe(1);
    expect(back[2]).toBe(-1);
    expect(back[3]).toBeCloseTo(0.5, 3);
  });

  it("goes through base64 and back unchanged, and drops a stray odd byte", () => {
    const pcm = new Int16Array([1, -1, 1000, -32768, 32767]);
    const b64 = bytesToBase64(new Uint8Array(pcm.buffer));
    expect([...base64ToInt16(b64)]).toEqual([...pcm]);
    expect(base64ToInt16(bytesToBase64(new Uint8Array([1, 0, 7])))).toHaveLength(1);
    expect(base64ToInt16("")).toHaveLength(0);
  });

  it("base64s a buffer bigger than one chunk", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 251);
    expect(Buffer.from(bytesToBase64(bytes), "base64").equals(Buffer.from(bytes))).toBe(true);
  });

  it("takes 48 kHz down to 16 kHz by averaging each three samples", () => {
    const out = downsample(new Float32Array([0.3, 0.3, 0.3, -0.6, 0, 0, 1, 1, 1, 0.5]), 48_000, 16_000);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeCloseTo(0.3);
    expect(out[1]).toBeCloseTo(-0.2);
    expect(out[2]).toBeCloseTo(1);
  });

  it("handles a rate that doesn't divide evenly, and leaves a low enough rate alone", () => {
    expect(downsample(new Float32Array(4410), 44_100, 16_000)).toHaveLength(1600);
    const same = new Float32Array([0.1, 0.2]);
    expect(downsample(same, 16_000, 16_000)).toBe(same);
    expect(downsample(same, 8_000, 16_000)).toBe(same);
  });
});
