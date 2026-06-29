/**
 * Semantic chunker for the knowledge-ingestion worker. Splits normalized
 * markdown (docs/site pages) and source-code files into embedding-sized chunks:
 *
 *  - Markdown splits at structural headings (#, ##, ###) and fenced code blocks.
 *  - A fenced code block is ATOMIC — never split mid-fence (only hard-split by
 *    whole lines if a single fence exceeds the cap).
 *  - Code files split at top-level boundaries (a non-indented line that starts a
 *    new declaration) when possible, else by whole-line windows — never mid-line.
 *  - Chunks cap at ~1200 tokens (~4800 chars), and adjacent TEXT chunks carry a
 *    ~15% overlap so context spanning a boundary isn't lost (code chunks do not
 *    overlap — duplicated code is noise, not context).
 *
 * Pure + dependency-free so it is unit-tested without any GCP/network.
 */

export interface ChunkInput {
  text: string;
  sourceUri: string;
  /** File path within a repo, or URL path for a page (used as title/citation). */
  path?: string | null;
  /** True when `text` is a raw source-code file (vs normalized markdown). */
  isCode?: boolean;
  /** Language hint for the code fence (e.g. "ts"); only used when isCode. */
  lang?: string;
}

export interface Chunk {
  content: string;
  title: string;
  path: string | null;
  heading: string | null;
  tokenCount: number;
  chunkIndex: number;
}

export const MAX_TOKENS = 1200;
const CHARS_PER_TOKEN = 4;
export const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN; // ~4800
const OVERLAP_RATIO = 0.15;

/** Cheap token estimate (the embedding model autoTruncates, so this only needs
 *  to be roughly right to keep chunks within a sane size). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

type Block =
  | { kind: "heading"; text: string; heading: string }
  | { kind: "code"; text: string; heading: string | null }
  | { kind: "text"; text: string; heading: string | null };

/** Parse markdown into heading / fenced-code / text blocks, tracking heading context. */
export function parseBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let heading: string | null = null;
  let textBuf: string[] = [];

  const flushText = () => {
    const t = textBuf.join("\n").trim();
    if (t) blocks.push({ kind: "text", text: t, heading });
    textBuf = [];
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const fence = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flushText();
      const marker = fence[2][0]; // ` or ~
      const code = [line];
      i += 1;
      while (i < lines.length) {
        code.push(lines[i]);
        const closed = new RegExp(`^\\s*${marker === "`" ? "`{3,}" : "~{3,}"}\\s*$`).test(
          lines[i],
        );
        i += 1;
        if (closed) break;
      }
      blocks.push({ kind: "code", text: code.join("\n"), heading });
      continue;
    }
    const h = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      flushText();
      heading = h[2].trim();
      blocks.push({ kind: "heading", text: line.trim(), heading });
      i += 1;
      continue;
    }
    textBuf.push(line);
    i += 1;
  }
  flushText();
  return blocks;
}

/** Tail slice of `s` carrying ~OVERLAP_RATIO of it, snapped to a line break. */
function overlapTail(s: string): string {
  const want = Math.floor(s.length * OVERLAP_RATIO);
  if (want <= 0) return "";
  let start = s.length - want;
  const nl = s.indexOf("\n", start);
  if (nl !== -1 && nl < s.length - 1) start = nl + 1;
  return s.slice(start).trimStart();
}

/** Hard-split an oversize single string by whole lines into <= MAX_CHARS windows. */
function splitByLines(text: string, overlap: boolean): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    if (buf.length === 0) return;
    const joined = buf.join("\n");
    out.push(joined);
    if (overlap) {
      const tail = overlapTail(joined);
      buf = tail ? [tail] : [];
      len = tail.length;
    } else {
      buf = [];
      len = 0;
    }
  };
  for (const line of lines) {
    // A single line longer than the cap: emit it on its own (cannot split mid-line).
    if (line.length >= MAX_CHARS) {
      flush();
      out.push(line);
      continue;
    }
    if (len + line.length + 1 > MAX_CHARS && buf.length > 0) flush();
    buf.push(line);
    len += line.length + 1;
  }
  flush();
  return out;
}

function titleFor(input: ChunkInput, heading: string | null): string {
  return heading || input.path || input.sourceUri || "source";
}

/** Chunk a source-code file: split at top-level boundaries, then cap by lines. */
function chunkCode(input: ChunkInput): Chunk[] {
  const lang = input.lang ?? "";
  const lines = input.text.split(/\r?\n/);
  // Group lines into segments that each begin at a top-level boundary (a
  // non-indented, non-blank line) so a chunk break prefers a declaration edge.
  const segments: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    const topLevel = line.length > 0 && !/^\s/.test(line);
    if (topLevel && cur.length > 0) {
      segments.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length > 0) segments.push(cur.join("\n"));

  // Pack segments to the cap (code chunks do NOT overlap).
  const packed: string[] = [];
  let buf = "";
  for (const seg of segments) {
    if (estimateTokens(buf + "\n" + seg) > MAX_TOKENS && buf) {
      packed.push(buf);
      buf = "";
    }
    buf = buf ? `${buf}\n${seg}` : seg;
    if (estimateTokens(buf) > MAX_TOKENS) {
      // A single oversize segment: hard-split by lines.
      for (const piece of splitByLines(buf, false)) packed.push(piece);
      buf = "";
    }
  }
  if (buf) packed.push(buf);

  return packed
    .filter((c) => c.trim())
    .map((code, chunkIndex) => {
      const content = "```" + lang + "\n" + code.replace(/\n+$/, "") + "\n```";
      return {
        content,
        title: input.path || input.sourceUri || "source",
        path: input.path ?? null,
        heading: null,
        tokenCount: estimateTokens(content),
        chunkIndex,
      };
    });
}

/** Split a sentence that alone exceeds the cap into <= MAX_CHARS word groups. */
function splitHugeSentence(s: string): string[] {
  if (s.length <= MAX_CHARS) return [s];
  const words = s.split(/\s+/);
  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;
  for (const w of words) {
    if (len + w.length + 1 > MAX_CHARS && buf.length) {
      out.push(buf.join(" "));
      buf = [];
      len = 0;
    }
    buf.push(w);
    len += w.length + 1;
  }
  if (buf.length) out.push(buf.join(" "));
  return out;
}

/**
 * Split an oversize TEXT block into <= MAX_CHARS sentence windows with ~15%
 * overlap (the next window starts a few sentences before the previous ended, so
 * context spanning a boundary isn't lost).
 */
function slidingWindows(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .flatMap(splitHugeSentence)
    .filter((s) => s.length > 0);
  const windows: string[] = [];
  const overlapChars = Math.floor(MAX_CHARS * OVERLAP_RATIO);
  let i = 0;
  while (i < sentences.length) {
    let j = i;
    let len = 0;
    while (j < sentences.length && len + sentences[j].length + 1 <= MAX_CHARS) {
      len += sentences[j].length + 1;
      j += 1;
    }
    if (j === i) j = i + 1; // guard: always make progress
    windows.push(sentences.slice(i, j).join(" "));
    if (j >= sentences.length) break;
    // Step back ~overlapChars worth of sentences for the next window's start.
    let back = 0;
    let blen = 0;
    while (j - 1 - back > i && blen < overlapChars) {
      blen += sentences[j - 1 - back].length;
      back += 1;
    }
    i = Math.max(j - back, i + 1); // never go backwards / stall
  }
  return windows;
}

type Unit = { text: string; heading: string | null; isHeading: boolean };

/** Expand parsed blocks into emittable units, splitting any that exceed the cap. */
function toUnits(blocks: Block[]): Unit[] {
  const units: Unit[] = [];
  for (const b of blocks) {
    if (b.kind === "heading") {
      units.push({ text: b.text, heading: b.heading, isHeading: true });
    } else if (b.kind === "code") {
      if (estimateTokens(b.text) <= MAX_TOKENS) {
        units.push({ text: b.text, heading: b.heading, isHeading: false });
      } else {
        for (const p of splitByLines(b.text, false)) {
          units.push({ text: p, heading: b.heading, isHeading: false });
        }
      }
    } else {
      if (estimateTokens(b.text) <= MAX_TOKENS) {
        units.push({ text: b.text, heading: b.heading, isHeading: false });
      } else {
        for (const w of slidingWindows(b.text)) {
          units.push({ text: w, heading: b.heading, isHeading: false });
        }
      }
    }
  }
  return units;
}

/**
 * Chunk normalized markdown: a heading forces a chunk boundary (split at #/##/###);
 * everything else packs to the cap; oversize blocks were pre-split (text → sliding
 * windows with overlap; code → whole-line windows).
 */
function chunkMarkdown(input: ChunkInput): Chunk[] {
  const units = toUnits(parseBlocks(input.text));
  const chunks: Chunk[] = [];
  let buf = "";
  let bufHeading: string | null = null;

  const flush = () => {
    const content = buf.trim();
    if (content) {
      chunks.push({
        content,
        title: titleFor(input, bufHeading),
        path: input.path ?? null,
        heading: bufHeading,
        tokenCount: estimateTokens(content),
        chunkIndex: chunks.length,
      });
    }
    buf = "";
  };

  for (const u of units) {
    if (u.isHeading) {
      flush();
      bufHeading = u.heading;
      buf = u.text;
      continue;
    }
    if (buf && estimateTokens(`${buf}\n${u.text}`) > MAX_TOKENS) {
      flush();
      bufHeading = u.heading;
      buf = u.text;
      continue;
    }
    if (!buf) bufHeading = u.heading;
    buf = buf ? `${buf}\n${u.text}` : u.text;
  }
  flush();
  return chunks.filter((c) => c.content);
}

/** Entry point: dispatch on content kind. Re-indexes chunkIndex sequentially. */
export function chunkSource(input: ChunkInput): Chunk[] {
  if (!input.text || !input.text.trim()) return [];
  const chunks = input.isCode ? chunkCode(input) : chunkMarkdown(input);
  return chunks.map((c, i) => ({ ...c, chunkIndex: i }));
}
