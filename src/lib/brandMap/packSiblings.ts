/**
 * Circle packing for the content map at any size: lays circles of given radii side by side,
 * none overlapping, around the origin, and returns the radius of the circle that encloses
 * them all. Deterministic (a fixed pseudo-random sequence), so the map looks the same on
 * every visit. Pure; client-safe.
 *
 * Adapted from d3-hierarchy's packSiblings and packEnclose (pack/siblings.js, pack/enclose.js,
 * lcg.js, array.js), whose licence follows:
 *
 * Copyright 2010-2023 Mike Bostock
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose
 * with or without fee is hereby granted, provided that the above copyright notice
 * and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 * OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 * TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 * THIS SOFTWARE.
 */

export interface Circle {
  x: number;
  y: number;
  r: number;
}

/** d3's linear congruential generator: the same sequence every time. */
function lcg(): () => number {
  const a = 1664525;
  const c = 1013904223;
  const m = 4294967296;
  let s = 1;
  return () => (s = (a * s + c) % m) / m;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  let m = items.length;
  while (m) {
    const i = (random() * m--) | 0;
    const t = items[m]!;
    items[m] = items[i]!;
    items[i] = t;
  }
  return items;
}

function enclosesNot(a: Circle, b: Circle): boolean {
  const dr = a.r - b.r;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dr < 0 || dr * dr < dx * dx + dy * dy;
}

function enclosesWeak(a: Circle, b: Circle): boolean {
  const dr = a.r - b.r + Math.max(a.r, b.r, 1) * 1e-9;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}

function enclosesWeakAll(a: Circle, basis: Circle[]): boolean {
  for (const b of basis) if (!enclosesWeak(a, b)) return false;
  return true;
}

function encloseBasis1(a: Circle): Circle {
  return { x: a.x, y: a.y, r: a.r };
}

function encloseBasis2(a: Circle, b: Circle): Circle {
  const x21 = b.x - a.x;
  const y21 = b.y - a.y;
  const r21 = b.r - a.r;
  const l = Math.sqrt(x21 * x21 + y21 * y21);
  return { x: (a.x + b.x + (x21 / l) * r21) / 2, y: (a.y + b.y + (y21 / l) * r21) / 2, r: (l + a.r + b.r) / 2 };
}

function encloseBasis3(a: Circle, b: Circle, c: Circle): Circle {
  const x1 = a.x;
  const y1 = a.y;
  const r1 = a.r;
  const a2 = x1 - b.x;
  const a3 = x1 - c.x;
  const b2 = y1 - b.y;
  const b3 = y1 - c.y;
  const c2 = b.r - r1;
  const c3 = c.r - r1;
  const d1 = x1 * x1 + y1 * y1 - r1 * r1;
  const d2 = d1 - b.x * b.x - b.y * b.y + b.r * b.r;
  const d3 = d1 - c.x * c.x - c.y * c.y + c.r * c.r;
  const ab = a3 * b2 - a2 * b3;
  const xa = (b2 * d3 - b3 * d2) / (ab * 2) - x1;
  const xb = (b3 * c2 - b2 * c3) / ab;
  const ya = (a3 * d2 - a2 * d3) / (ab * 2) - y1;
  const yb = (a2 * c3 - a3 * c2) / ab;
  const A = xb * xb + yb * yb - 1;
  const B = 2 * (r1 + xa * xb + ya * yb);
  const C = xa * xa + ya * ya - r1 * r1;
  const r = -(Math.abs(A) > 1e-6 ? (B + Math.sqrt(B * B - 4 * A * C)) / (2 * A) : C / B);
  return { x: x1 + xa + xb * r, y: y1 + ya + yb * r, r };
}

function encloseBasis(basis: Circle[]): Circle {
  if (basis.length === 1) return encloseBasis1(basis[0]!);
  if (basis.length === 2) return encloseBasis2(basis[0]!, basis[1]!);
  return encloseBasis3(basis[0]!, basis[1]!, basis[2]!);
}

function extendBasis(basis: Circle[], p: Circle): Circle[] {
  if (enclosesWeakAll(p, basis)) return [p];
  for (const b of basis) {
    if (enclosesNot(p, b) && enclosesWeakAll(encloseBasis2(b, p), basis)) return [b, p];
  }
  for (let i = 0; i < basis.length - 1; i += 1) {
    for (let j = i + 1; j < basis.length; j += 1) {
      const bi = basis[i]!;
      const bj = basis[j]!;
      if (
        enclosesNot(encloseBasis2(bi, bj), p) &&
        enclosesNot(encloseBasis2(bi, p), bj) &&
        enclosesNot(encloseBasis2(bj, p), bi) &&
        enclosesWeakAll(encloseBasis3(bi, bj, p), basis)
      ) {
        return [bi, bj, p];
      }
    }
  }
  throw new Error("packEnclose: no basis");
}

/** The smallest circle that encloses these circles (Welzl's algorithm, as d3 has it). */
export function packEnclose(circles: Circle[], random: () => number = lcg()): Circle | null {
  const items = shuffle([...circles], random);
  let basis: Circle[] = [];
  let e: Circle | null = null;
  let i = 0;
  while (i < items.length) {
    const p = items[i]!;
    if (e && enclosesWeak(e, p)) i += 1;
    else {
      basis = extendBasis(basis, p);
      e = encloseBasis(basis);
      i = 0;
    }
  }
  return e;
}

function place(b: Circle, a: Circle, c: Circle): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2) {
    let a2 = a.r + c.r;
    a2 *= a2;
    let b2 = b.r + c.r;
    b2 *= b2;
    if (a2 > b2) {
      const x = (d2 + b2 - a2) / (2 * d2);
      const y = Math.sqrt(Math.max(0, b2 / d2 - x * x));
      c.x = b.x - x * dx - y * dy;
      c.y = b.y - x * dy + y * dx;
    } else {
      const x = (d2 + a2 - b2) / (2 * d2);
      const y = Math.sqrt(Math.max(0, a2 / d2 - x * x));
      c.x = a.x + x * dx - y * dy;
      c.y = a.y + x * dy + y * dx;
    }
  } else {
    c.x = a.x + c.r;
    c.y = a.y;
  }
}

function intersects(a: Circle, b: Circle): boolean {
  const dr = a.r + b.r - 1e-6;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}

interface Node {
  c: Circle;
  next: Node;
  previous: Node;
}

function score(node: Node): number {
  const a = node.c;
  const b = node.next.c;
  const ab = a.r + b.r;
  const dx = (a.x * b.r + b.x * a.r) / ab;
  const dy = (a.y * b.r + b.y * a.r) / ab;
  return dx * dx + dy * dy;
}

function node(c: Circle): Node {
  const n = { c } as Node;
  n.next = n;
  n.previous = n;
  return n;
}

/**
 * Place the circles (their `r` set; `x`, `y` are written) side by side around the origin, in
 * the order given (biggest first packs tightest). Returns the enclosing circle's radius.
 */
export function packSiblings(circles: Circle[]): number {
  const n = circles.length;
  if (!n) return 0;
  const a0 = circles[0]!;
  a0.x = 0;
  a0.y = 0;
  if (n === 1) return a0.r;
  const b0 = circles[1]!;
  a0.x = -b0.r;
  b0.x = a0.r;
  b0.y = 0;
  if (n === 2) return a0.r + b0.r;
  place(b0, a0, circles[2]!);

  // The front chain: the circles on the outside, in order.
  let a = node(a0);
  let b = node(b0);
  let c = node(circles[2]!);
  a.next = c.previous = b;
  b.next = a.previous = c;
  c.next = b.previous = a;

  pack: for (let i = 3; i < n; i += 1) {
    place(a.c, b.c, circles[i]!);
    c = node(circles[i]!);
    // The closest circle on the front chain this one overlaps, if any, by distance along it.
    let j = b.next;
    let k = a.previous;
    let sj = b.c.r;
    let sk = a.c.r;
    do {
      if (sj <= sk) {
        if (intersects(j.c, c.c)) {
          b = j;
          a.next = b;
          b.previous = a;
          i -= 1;
          continue pack;
        }
        sj += j.c.r;
        j = j.next;
      } else {
        if (intersects(k.c, c.c)) {
          a = k;
          a.next = b;
          b.previous = a;
          i -= 1;
          continue pack;
        }
        sk += k.c.r;
        k = k.previous;
      }
    } while (j !== k.next);

    // Insert it between a and b, then find the pair closest to the centre.
    c.previous = a;
    c.next = b;
    a.next = b.previous = b = c;
    let aa = score(a);
    while ((c = c.next) !== b) {
      const ca = score(c);
      if (ca < aa) {
        a = c;
        aa = ca;
      }
    }
    b = a.next;
  }

  // Centre the enclosing circle of the front chain on the origin.
  const chain: Circle[] = [b.c];
  c = b;
  while ((c = c.next) !== b) chain.push(c.c);
  const e = packEnclose(chain)!;
  for (const circle of circles) {
    circle.x -= e.x;
    circle.y -= e.y;
  }
  return e.r;
}
