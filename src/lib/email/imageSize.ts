/**
 * An image's pixel size, read from its own header — no decoding, no dependency. Pure. The
 * email header-image upload uses it to refuse an oversized file (or a small file declaring a
 * huge size) and to record the size the band's `height` attribute is built from, so that
 * never depends on a browser's measurement. It also stores the file without its metadata
 * (stripImageMetadata), since the banner is served publicly to every recipient.
 */

export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** PNG (the IHDR chunk) or JPEG (the first SOFn segment). Null when unreadable or zero. */
export function readImageSize(bytes: Uint8Array): ImageSize | null {
  return pngSize(bytes) ?? jpegSize(bytes);
}

const u16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32 = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

function sized(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The signature, then the first chunk, which must be IHDR: width at 16, height at 20 (big-endian). */
function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return null;
  // "IHDR"
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  return sized(u32(b, 16), u32(b, 20));
}

/** A start-of-frame marker: C0–CF, except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/**
 * Walk the segments after SOI until the first SOFn: its height is at +5 and width at +7 from
 * the marker's 0xFF. Stops (null) at SOS or EOI, on a bad marker, or on a segment that runs
 * past the end.
 */
function jpegSize(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    // Fill bytes: any number of 0xFF before the marker.
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return null;
    const marker = b[i]!;
    i++;
    // Standalone markers carry no length: TEM, RST0–7, and a stray SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (i + 2 > b.length) return null;
    const length = u16(b, i);
    if (length < 2 || i + length > b.length) return null;
    if (isSof(marker)) {
      // Length, precision (1), height (2), width (2).
      if (length < 7) return null;
      return sized(u16(b, i + 5), u16(b, i + 3));
    }
    i += length;
  }
  return null;
}

/**
 * The image without its metadata, for a file served publicly to every email recipient: a PNG
 * keeps only the chunks that draw it (IHDR, PLTE, tRNS, IDAT, IEND, and the colour ones gAMA,
 * cHRM, sRGB, iCCP, sBIT), so eXIf, tEXt/zTXt/iTXt (author, software, XMP), tIME and the rest
 * go; a JPEG loses COM and every APPn but a JFIF APP0 (its thumbnail dropped), the ICC profile
 * (APP2) and Adobe's colour transform (APP14), so EXIF (GPS, camera, orientation) and XMP go.
 * Whatever follows the end (IEND, EOI) goes too. The pixels are copied as they are. Null when
 * the file isn't a whole, readable PNG or JPEG.
 */
export function stripImageMetadata(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) return stripPng(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return stripJpeg(bytes);
  return null;
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ascii = (b: Uint8Array, i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

/** The chunks a PNG needs to be drawn as it looks: the critical four, transparency, and colour. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT"]);

/**
 * Chunk by chunk (length, type, data, CRC), from IHDR to IEND; null if one runs past the end or
 * IEND never comes.
 */
function stripPng(b: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const end = i + 12 + u32(b, i);
    if (end > b.length) return null;
    const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!);
    if (i === 8 && type !== "IHDR") return null;
    if (PNG_KEEP.has(type)) parts.push(b.subarray(i, end));
    if (type === "IEND") return joined(parts);
    i = end;
  }
  return null;
}

/** A JFIF APP0 payload without its thumbnail (version, units and density kept); null if it isn't one. */
function jfifWithoutThumbnail(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 14 || !ascii(payload, 0, "JFIF\0")) return null;
  const kept = new Uint8Array(14);
  kept.set(payload.subarray(0, 12)); // "JFIF\0", version (2), units (1), X and Y density (2 each)
  return kept; // thumbnail width and height 0, and no thumbnail
}

/** An APPn or COM segment's payload as kept (possibly trimmed), or null to drop it. */
function keptPayload(marker: number, payload: Uint8Array): Uint8Array | null {
  if (marker === 0xe0) return jfifWithoutThumbnail(payload);
  if (marker === 0xe2) return ascii(payload, 0, "ICC_PROFILE\0") ? payload : null;
  if (marker === 0xee) return ascii(payload, 0, "Adobe") ? payload : null;
  return null; // every other APPn (EXIF, XMP, MPF, …) and COM
}

/**
 * In scan data, a marker starts at 0xFF unless a stuffed 0x00 or an RSTn follows (both are part
 * of the data); 0xFF 0xFF is fill before one.
 */
function startsMarker(b: Uint8Array, i: number): boolean {
  if (b[i] !== 0xff || i + 1 >= b.length) return false;
  const m = b[i + 1]!;
  return m !== 0x00 && !(m >= 0xd0 && m <= 0xd7);
}

/**
 * Segment by segment after SOI: APPn (E0–EF) and COM (FE) are kept only as keptPayload says,
 * everything else as it is; after SOS, its entropy-coded data runs to the next marker that
 * isn't a stuffed 0xFF00 or an RSTn. Ends at EOI; null if a segment runs past the end, a
 * marker isn't one, or EOI never comes.
 */
function stripJpeg(b: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    // Fill bytes: any number of 0xFF before the marker.
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return null;
    const marker = b[i]!;
    i++;
    if (marker === 0xd9) {
      parts.push(Uint8Array.of(0xff, 0xd9));
      return joined(parts);
    }
    // Standalone markers carry no length: TEM and RST0–7. A second SOI isn't a JPEG.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(Uint8Array.of(0xff, marker));
      continue;
    }
    if (marker === 0xd8 || marker === 0x00) return null;
    if (i + 2 > b.length) return null;
    const length = u16(b, i);
    if (length < 2 || i + length > b.length) return null;
    const end = i + length;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      const payload = keptPayload(marker, b.subarray(i + 2, end));
      if (payload) {
        const kept = payload.length + 2;
        parts.push(Uint8Array.of(0xff, marker, kept >> 8, kept & 0xff), payload);
      }
      i = end;
      continue;
    }
    let next = end;
    if (marker === 0xda) {
      // SOS: the scan's data follows its header, up to the next real marker.
      while (next < b.length && !startsMarker(b, next)) next++;
    }
    parts.push(b.subarray(i - 2, next));
    i = next;
  }
  return null;
}
