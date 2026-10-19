import { inflateSync } from "node:zlib";

/**
 * Reads what the image renderer needs from a font file, with no dependency: its family name,
 * weight and italic (the `name`, `OS/2` and `head` tables) and which characters it has (`cmap`
 * formats 4 and 12). Takes TTF, OTF, a TrueType collection (first face) or WOFF (whose tables are
 * zlib). A WOFF2 has to be unpacked to TTF first (see fonts.ts). Never throws: a file it can't
 * read gives null.
 */

export interface FontInfo {
  family: string | null;
  /** usWeightClass, 1 to 1000 (400 regular, 700 bold). */
  weight: number;
  italic: boolean;
}

/** Biggest table we'll inflate from a WOFF (a whole font is capped at 5 MB on upload). */
const MAX_TABLE_BYTES = 20 * 1024 * 1024;

type Tables = Map<string, DataView>;

function tag(v: DataView, at: number): string {
  return String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
}

function sfntTables(v: DataView, start: number): Tables | null {
  const numTables = v.getUint16(start + 4);
  if (numTables === 0 || numTables > 200) return null;
  const tables: Tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec = start + 12 + i * 16;
    const offset = v.getUint32(rec + 8);
    const length = v.getUint32(rec + 12);
    if (offset + length > v.byteLength) return null;
    tables.set(tag(v, rec), new DataView(v.buffer, v.byteOffset + offset, length));
  }
  return tables;
}

function woffTables(v: DataView): Tables | null {
  const numTables = v.getUint16(12);
  if (numTables === 0 || numTables > 200) return null;
  const tables: Tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec = 44 + i * 20;
    const offset = v.getUint32(rec + 4);
    const compLength = v.getUint32(rec + 8);
    const origLength = v.getUint32(rec + 12);
    if (offset + compLength > v.byteLength || origLength > MAX_TABLE_BYTES) return null;
    const raw = new Uint8Array(v.buffer, v.byteOffset + offset, compLength);
    const data = compLength < origLength ? inflateSync(raw, { maxOutputLength: origLength }) : raw;
    if (data.byteLength !== origLength) return null;
    tables.set(tag(v, rec), new DataView(data.buffer, data.byteOffset, data.byteLength));
  }
  return tables;
}

function readTables(bytes: Uint8Array): Tables | null {
  if (bytes.byteLength < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = tag(v, 0);
  if (sig === "wOFF") return bytes.byteLength >= 44 ? woffTables(v) : null;
  if (sig === "ttcf") return sfntTables(v, v.getUint32(12));
  if (sig === "OTTO" || sig === "true" || v.getUint32(0) === 0x00010000) return sfntTables(v, 0);
  return null;
}

function utf16be(v: DataView, at: number, length: number): string {
  let s = "";
  for (let i = 0; i + 1 < length; i += 2) s += String.fromCharCode(v.getUint16(at + i));
  return s;
}

function latin1(v: DataView, at: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(v.getUint8(at + i));
  return s;
}

/** The typographic family (name 16), else the family (name 1); Windows English first. */
function familyName(name: DataView | undefined): string | null {
  if (!name || name.byteLength < 6) return null;
  const count = name.getUint16(2);
  const strings = name.getUint16(4);
  let best: { score: number; text: string } | null = null;
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > name.byteLength) break;
    const platform = name.getUint16(rec);
    const lang = name.getUint16(rec + 4);
    const id = name.getUint16(rec + 6);
    const length = name.getUint16(rec + 8);
    const at = strings + name.getUint16(rec + 10);
    if ((id !== 1 && id !== 16) || at + length > name.byteLength) continue;
    const text = (platform === 1 ? latin1(name, at, length) : utf16be(name, at, length)).trim();
    if (!text) continue;
    const score = (id === 16 ? 4 : 0) + (platform === 3 ? 2 : 0) + (platform !== 3 || lang === 0x409 ? 1 : 0);
    if (!best || score > best.score) best = { score, text };
  }
  return best ? best.text.slice(0, 80) : null;
}

export function fontInfo(bytes: Uint8Array): FontInfo | null {
  try {
    const tables = readTables(bytes);
    if (!tables) return null;
    const os2 = tables.get("OS/2");
    const head = tables.get("head");
    if (!os2 && !head) return null;
    let weight = 400;
    let italic = false;
    if (os2 && os2.byteLength >= 64) {
      const w = os2.getUint16(4);
      if (w >= 1 && w <= 1000) weight = w;
      const fsSelection = os2.getUint16(62);
      italic = (fsSelection & 0x0001) !== 0 || (fsSelection & 0x0200) !== 0;
    } else if (head && head.byteLength >= 46) {
      const macStyle = head.getUint16(44);
      if (macStyle & 0x0001) weight = 700;
      italic = (macStyle & 0x0002) !== 0;
    }
    return { family: familyName(tables.get("name")), weight, italic };
  } catch {
    return null;
  }
}

/** Whether `cp` maps to a real glyph, for the best Unicode cmap subtable (format 12, else 4). */
function cmapLookup(cmap: DataView): ((cp: number) => boolean) | null {
  const count = cmap.getUint16(2);
  let format4: number | null = null;
  let format12: number | null = null;
  for (let i = 0; i < count; i++) {
    const rec = 4 + i * 8;
    const platform = cmap.getUint16(rec);
    const encoding = cmap.getUint16(rec + 2);
    const offset = cmap.getUint32(rec + 4);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || offset + 4 > cmap.byteLength) continue;
    const format = cmap.getUint16(offset);
    if (format === 12 && format12 === null) format12 = offset;
    if (format === 4 && format4 === null) format4 = offset;
  }
  if (format12 !== null) {
    const at = format12;
    const groups = cmap.getUint32(at + 12);
    return (cp) => {
      for (let g = 0; g < groups; g++) {
        const rec = at + 16 + g * 12;
        if (cp >= cmap.getUint32(rec) && cp <= cmap.getUint32(rec + 4)) {
          return cmap.getUint32(rec + 8) + (cp - cmap.getUint32(rec)) !== 0;
        }
      }
      return false;
    };
  }
  if (format4 !== null) {
    const at = format4;
    const segCount = cmap.getUint16(at + 6) / 2;
    const ends = at + 14;
    const starts = ends + segCount * 2 + 2;
    const deltas = starts + segCount * 2;
    const ranges = deltas + segCount * 2;
    return (cp) => {
      if (cp > 0xffff) return false;
      for (let s = 0; s < segCount; s++) {
        if (cmap.getUint16(ends + s * 2) < cp) continue;
        const start = cmap.getUint16(starts + s * 2);
        if (start > cp) return false;
        const delta = cmap.getUint16(deltas + s * 2);
        const rangeAt = ranges + s * 2;
        const rangeOffset = cmap.getUint16(rangeAt);
        if (rangeOffset === 0) return ((cp + delta) & 0xffff) !== 0;
        const glyphAt = rangeAt + rangeOffset + (cp - start) * 2;
        if (glyphAt + 2 > cmap.byteLength) return false;
        return cmap.getUint16(glyphAt) !== 0;
      }
      return false;
    };
  }
  return null;
}

/**
 * The characters of `text` this font can't draw (spaces and control characters don't count).
 * Null when the font can't be read, which callers treat as "don't use it".
 */
export function missingCharacters(bytes: Uint8Array, text: string): string[] | null {
  try {
    const cmap = readTables(bytes)?.get("cmap");
    if (!cmap) return null;
    const has = cmapLookup(cmap);
    if (!has) return null;
    const missing = new Set<string>();
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x21 || (cp >= 0x7f && cp < 0xa0) || /\s/.test(ch)) continue;
      if (!has(cp)) missing.add(ch);
    }
    return [...missing];
  } catch {
    return null;
  }
}
