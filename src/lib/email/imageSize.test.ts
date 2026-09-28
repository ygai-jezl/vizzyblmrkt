import { describe, expect, it } from "vitest";
import { readImageSize, stripImageMetadata } from "./imageSize";

// Hand-built headers: only the bytes readImageSize looks at, plus what it must skip.
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (w: number, h: number, tag = "IHDR") =>
  bytes(PNG_SIG, be32(13), ascii(tag), be32(w), be32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0]);

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
/** A segment: marker, then a length that counts itself and the payload. */
const seg = (marker: number, payload: number[]) => [0xff, marker, ...be16(payload.length + 2), ...payload];
const APP0 = seg(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const sof = (marker: number, w: number, h: number) => seg(marker, [8, ...be16(h), ...be16(w), 1, 1, 0x11, 0]);
const SOS = seg(0xda, [1, 1, 0, 0, 0x3f, 0]);

describe("readImageSize", () => {
  it("reads a PNG's IHDR", () => {
    expect(readImageSize(png(1200, 300))).toEqual({ width: 1200, height: 300 });
    expect(readImageSize(Buffer.from(png(1, 2400)))).toEqual({ width: 1, height: 2400 });
    expect(readImageSize(png(70000, 3))).toEqual({ width: 70000, height: 3 });
  });

  it("reads a baseline JPEG (APP0 then SOF0) and a progressive one (SOF2)", () => {
    expect(readImageSize(bytes(SOI, APP0, sof(0xc0, 1200, 300), SOS, EOI))).toEqual({ width: 1200, height: 300 });
    expect(readImageSize(bytes(SOI, APP0, sof(0xc2, 640, 480), SOS, EOI))).toEqual({ width: 640, height: 480 });
  });

  it("skips a DHT (C4) before the SOF, rather than reading it as one", () => {
    // A DHT whose payload would read as 22136 × 4660 if it were taken for a SOF.
    const dht = seg(0xc4, [0x00, 0x12, 0x34, 0x56, 0x78, 0x00, 0x00, 0x00]);
    expect(readImageSize(bytes(SOI, APP0, dht, sof(0xc0, 800, 200), SOS, EOI))).toEqual({ width: 800, height: 200 });
  });

  it("skips fill bytes and standalone markers between segments", () => {
    expect(readImageSize(bytes(SOI, [0xff, 0xff], APP0, [0xff, 0xd0], sof(0xc1, 300, 100), EOI))).toEqual({
      width: 300,
      height: 100,
    });
  });

  it("null when SOS or EOI comes before any SOF", () => {
    expect(readImageSize(bytes(SOI, APP0, SOS, sof(0xc0, 1200, 300)))).toBeNull();
    expect(readImageSize(bytes(SOI, APP0, EOI))).toBeNull();
    expect(readImageSize(bytes(SOI, APP0))).toBeNull();
  });

  it("null for a truncated segment", () => {
    // APP0 claims 16 bytes but the file ends first.
    expect(readImageSize(bytes(SOI, [0xff, 0xe0, 0x00, 0x10], ascii("JF")))).toBeNull();
    // The SOF itself is cut off before its width.
    expect(readImageSize(bytes(SOI, sof(0xc0, 1200, 300).slice(0, 8)))).toBeNull();
    // A length too small to be one.
    expect(readImageSize(bytes(SOI, [0xff, 0xe0, 0x00, 0x01], APP0))).toBeNull();
    expect(readImageSize(png(1200, 300).slice(0, 23))).toBeNull();
  });

  it("null for a bad signature, a marker that isn't one, or another format", () => {
    expect(readImageSize(bytes([0x88], [...png(1200, 300).slice(1)]))).toBeNull();
    expect(readImageSize(png(1200, 300, "IDAT"))).toBeNull();
    expect(readImageSize(bytes(SOI, [0x00, 0xc0], sof(0xc0, 1200, 300)))).toBeNull();
    expect(readImageSize(bytes(ascii("RIFF"), be32(30), ascii("WEBPVP8 "), new Array(20).fill(1)))).toBeNull();
    expect(readImageSize(bytes(ascii("GIF89a"), be16(1200), be16(300)))).toBeNull();
    expect(readImageSize(new Uint8Array())).toBeNull();
  });

  it("null for a zero width or height", () => {
    expect(readImageSize(png(0, 300))).toBeNull();
    expect(readImageSize(png(1200, 0))).toBeNull();
    expect(readImageSize(bytes(SOI, sof(0xc0, 1200, 0), EOI))).toBeNull();
    expect(readImageSize(bytes(SOI, sof(0xc0, 0, 300), EOI))).toBeNull();
  });
});

describe("stripImageMetadata", () => {
  const CRC = [0x12, 0x34, 0x56, 0x78];
  /** A chunk: length, type, data, CRC (not checked, so a made-up one). */
  const chunk = (type: string, data: number[] = []) => [...be32(data.length), ...ascii(type), ...data, ...CRC];
  const IHDR = chunk("IHDR", [...be32(1200), ...be32(300), 8, 6, 0, 0, 0]);
  const IDAT = chunk("IDAT", [0x78, 0x9c, 0x63, 0x00, 0x00]);
  const IEND = chunk("IEND");
  const has = (b: Uint8Array | null, s: string) => !!b && Buffer.from(b).includes(s);

  it("keeps a PNG's drawing and colour chunks and drops the rest, and anything after IEND", () => {
    const kept = [chunk("sRGB", [0]), chunk("gAMA", be32(45455)), chunk("PLTE", [1, 2, 3]), chunk("tRNS", [0])];
    const clean = bytes(PNG_SIG, IHDR, ...kept, IDAT, IEND);
    const dirty = bytes(
      PNG_SIG,
      IHDR,
      chunk("eXIf", ascii("MM GPS 51.5N")),
      ...kept,
      chunk("tEXt", ascii("Author\0A. Person")),
      chunk("iTXt", ascii("XML:com.adobe.xmp\0<x:xmpmeta/>")),
      chunk("zTXt", ascii("Comment\0")),
      chunk("tIME", [7, 234, 9, 28, 0, 0, 0]),
      IDAT,
      chunk("prVt", ascii("private")),
      IEND,
      ascii("appended data"),
    );
    const out = stripImageMetadata(dirty);
    expect(out).toEqual(clean);
    for (const s of ["eXIf", "GPS", "tEXt", "Author", "iTXt", "xmpmeta", "zTXt", "tIME", "prVt", "appended"]) {
      expect(has(out, s)).toBe(false);
    }
    expect(readImageSize(out!)).toEqual({ width: 1200, height: 300 });
    // A clean one comes back as it is.
    expect(stripImageMetadata(clean)).toEqual(clean);
  });

  it("null for a PNG that doesn't start with IHDR, runs past the end, or never ends", () => {
    expect(stripImageMetadata(bytes(PNG_SIG, IDAT, IHDR, IEND))).toBeNull();
    expect(stripImageMetadata(bytes(PNG_SIG, IHDR, IDAT))).toBeNull();
    expect(stripImageMetadata(bytes(PNG_SIG, IHDR, IDAT.slice(0, -1)))).toBeNull();
    expect(stripImageMetadata(png(1200, 300))).toBeNull(); // IHDR with no CRC
  });

  const EXIF = seg(0xe1, [...ascii("Exif"), 0, 0, ...ascii("MM GPS 51.5N")]);
  const XMP = seg(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii("<x:xmpmeta/>")]);
  const ICC = seg(0xe2, [...ascii("ICC_PROFILE"), 0, 1, 1, 0x00, 0x00, 0x02, 0x0c]);
  const MPF = seg(0xe2, [...ascii("MPF"), 0, 1, 2, 3]);
  const ADOBE = seg(0xee, [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 1]);
  const COM = seg(0xfe, ascii("Shot on a phone"));
  const DQT = seg(0xdb, [0, ...new Array(64).fill(1)]);
  /** Scan data with a stuffed 0xFF00 and a restart marker in it, which aren't the end of the scan. */
  const SCAN = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];

  it("keeps a JPEG's JFIF (without its thumbnail), ICC profile, Adobe transform and image data, and drops the rest", () => {
    const jfifThumb = seg(0xe0, [...ascii("JFIF"), 0, 1, 2, 1, 0, 72, 0, 72, 1, 1, 0xaa, 0xbb, 0xcc]);
    const jfif = seg(0xe0, [...ascii("JFIF"), 0, 1, 2, 1, 0, 72, 0, 72, 0, 0]);
    const jfxx = seg(0xe0, [...ascii("JFXX"), 0, 0x10, 0xff, 0xd8, 0xff, 0xd9]);
    const frame = sof(0xc2, 1200, 300);
    // Progressive: a COM between the scans, and a second image (MPF) after EOI.
    const dirty = bytes(
      SOI,
      jfifThumb,
      jfxx,
      EXIF,
      XMP,
      ICC,
      MPF,
      ADOBE,
      COM,
      DQT,
      frame,
      SOS,
      SCAN,
      COM,
      SOS,
      SCAN,
      EOI,
      ascii("second image"),
    );
    const out = stripImageMetadata(dirty);
    expect(out).toEqual(bytes(SOI, jfif, ICC, ADOBE, DQT, frame, SOS, SCAN, SOS, SCAN, EOI));
    for (const s of ["Exif", "GPS", "xmpmeta", "MPF", "JFXX", "Shot on", "second image"]) {
      expect(has(out, s)).toBe(false);
    }
    expect(readImageSize(out!)).toEqual({ width: 1200, height: 300 });
  });

  it("keeps a clean JPEG as it is, and standalone markers, but not fill bytes", () => {
    const clean = bytes(SOI, APP0, [0xff, 0xd0], sof(0xc0, 300, 100), SOS, SCAN, EOI);
    expect(stripImageMetadata(clean)).toEqual(clean);
    // Fill before a marker (between segments, or ending the scan) goes; the markers stay.
    const filled = bytes(SOI, [0xff, 0xff], APP0, [0xff, 0xff, 0xd0], sof(0xc0, 300, 100), SOS, SCAN, [0xff, 0xff], EOI);
    expect(stripImageMetadata(filled)).toEqual(clean);
  });

  it("null for a JPEG that runs past the end, has a bad marker, or never reaches EOI", () => {
    expect(stripImageMetadata(bytes(SOI, APP0, sof(0xc0, 300, 100), SOS, SCAN))).toBeNull();
    expect(stripImageMetadata(bytes(SOI, [0xff, 0xe1, 0x00, 0x40], ascii("Exif")))).toBeNull();
    expect(stripImageMetadata(bytes(SOI, [0x00, 0xc0], sof(0xc0, 300, 100), EOI))).toBeNull();
    expect(stripImageMetadata(bytes(SOI, SOI, EOI))).toBeNull();
    expect(stripImageMetadata(bytes(SOI, [0xff]))).toBeNull();
  });

  it("null for anything else", () => {
    expect(stripImageMetadata(bytes(ascii("GIF89a"), be16(1200), be16(300)))).toBeNull();
    expect(stripImageMetadata(bytes(ascii("RIFF"), be32(30), ascii("WEBPVP8 ")))).toBeNull();
    expect(stripImageMetadata(new Uint8Array())).toBeNull();
  });
});
