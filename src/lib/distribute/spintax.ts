/**
 * Recursive Spintax engine for content recycling: `{a|b|c}` groups (nestable)
 * expand to one randomly-chosen variant, so recurring posts avoid duplicate-content
 * penalties. Pure + client-safe. Escapes: `\{ \} \| \\` are literals.
 *
 * BOUNDED by design (anti-DoS): source length, nesting depth, and the reported
 * variant count are all capped so a crafted template can't hang or blow up memory.
 */

export const SPINTAX_MAX_SOURCE_CHARS = 8000;
export const SPINTAX_MAX_DEPTH = 20;
/** Variant counting saturates here — a template can express more, we just cap the display. */
export const SPINTAX_MAX_VARIANTS = 1_000_000;
export const SPINTAX_MAX_PREVIEWS = 20;

export class SpintaxError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "SpintaxError";
  }
}

// ---- AST -------------------------------------------------------------------

interface Group {
  alts: Seq[];
}
type Node = string | Group;
type Seq = Node[];

function isGroup(n: Node): n is Group {
  return typeof n !== "string";
}

// ---- Parser (recursive descent) -------------------------------------------

/**
 * Parse a sequence. `inGroup` = we're inside `{…}`, so an unescaped `|`/`}` ends
 * this sequence; at the top level they're literal characters.
 */
function parseSequence(
  src: string,
  start: number,
  depth: number,
  inGroup: boolean,
): { seq: Seq; next: number } {
  if (depth > SPINTAX_MAX_DEPTH) throw new SpintaxError("too_deeply_nested");
  const seq: Seq = [];
  let buf = "";
  let i = start;
  const flush = () => {
    if (buf) {
      seq.push(buf);
      buf = "";
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\" && i + 1 < src.length) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "{") {
      flush();
      const g = parseGroup(src, i, depth + 1);
      seq.push(g.group);
      i = g.next;
      continue;
    }
    if (inGroup && (c === "|" || c === "}")) break;
    buf += c;
    i += 1;
  }
  flush();
  return { seq, next: i };
}

function parseGroup(src: string, start: number, depth: number): { group: Group; next: number } {
  // src[start] === "{"
  let i = start + 1;
  const alts: Seq[] = [];
  for (;;) {
    const { seq, next } = parseSequence(src, i, depth, true);
    alts.push(seq);
    i = next;
    if (i >= src.length) throw new SpintaxError("unbalanced_braces");
    if (src[i] === "|") {
      i += 1;
      continue;
    }
    // src[i] === "}"
    i += 1;
    break;
  }
  return { group: { alts }, next: i };
}

function parse(source: string): Seq {
  if (source.length > SPINTAX_MAX_SOURCE_CHARS) throw new SpintaxError("too_long");
  const { seq } = parseSequence(source, 0, 0, false);
  return seq;
}

// ---- Public API ------------------------------------------------------------

/** Balanced-brace / depth / length check. Returns the reason on failure. */
export function validateSpintax(source: string): { ok: true } | { ok: false; error: string } {
  try {
    parse(source);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof SpintaxError ? err.reason : "invalid" };
  }
}

/** Does the source contain at least one spintax group? */
export function hasSpintax(source: string): boolean {
  const v = validateSpintax(source);
  if (!v.ok) return false;
  return parse(source).some(isGroup);
}

/** Total distinct variants, saturated at SPINTAX_MAX_VARIANTS. 1 for plain text. */
export function countVariants(source: string): number {
  let seq: Seq;
  try {
    seq = parse(source);
  } catch {
    return 1;
  }
  return countSeq(seq);
}

function countSeq(seq: Seq): number {
  let product = 1;
  for (const n of seq) {
    product *= isGroup(n) ? countGroup(n) : 1;
    if (product >= SPINTAX_MAX_VARIANTS) return SPINTAX_MAX_VARIANTS;
  }
  return product;
}

function countGroup(g: Group): number {
  let sum = 0;
  for (const alt of g.alts) {
    sum += countSeq(alt);
    if (sum >= SPINTAX_MAX_VARIANTS) return SPINTAX_MAX_VARIANTS;
  }
  return sum;
}

/**
 * Expand to ONE variant (one random option per group). NEVER throws — invalid
 * spintax falls back to the source verbatim, so a bad template can't break publish.
 */
export function expandSpintax(source: string, rng: () => number = Math.random): string {
  let seq: Seq;
  try {
    seq = parse(source);
  } catch {
    return source;
  }
  return expandSeq(seq, rng);
}

function expandSeq(seq: Seq, rng: () => number): string {
  let out = "";
  for (const n of seq) {
    if (isGroup(n)) {
      const alts = n.alts;
      const idx = Math.min(alts.length - 1, Math.max(0, Math.floor(rng() * alts.length)));
      out += expandSeq(alts[idx]!, rng);
    } else {
      out += n;
    }
  }
  return out;
}

/** A deterministic PRNG so previews are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Up to `n` sample expansions (deterministic for a given seed) for the editor. */
export function previewVariants(source: string, n = 5, seed = 1): string[] {
  const requested = Number.isFinite(n) ? Math.floor(n) : 1; // tolerate NaN/±Inf → ≥1
  const count = Math.min(Math.max(1, requested), SPINTAX_MAX_PREVIEWS);
  const rng = mulberry32(seed);
  const out: string[] = [];
  for (let k = 0; k < count; k += 1) out.push(expandSpintax(source, rng));
  return out;
}
