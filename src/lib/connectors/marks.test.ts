import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { GOOGLE_SIGN_IN } from "@/components/admin/connectors/ConnectorTile";
import { iconFiles, parseManifest } from "./manifest";
import { MANIFESTS } from "./manifests";

/**
 * The third-party marks under public/marks: every file a manifest or the Google button names is
 * there, is what its extension says, is big enough to stay sharp, carries nothing that could run,
 * and is listed in public/marks/NOTICE.md with its owner, source and SHA-256. Nothing else is there.
 */

const PUBLIC = join(process.cwd(), "public");
const MARKS = join(PUBLIC, "marks");
const NOTICE = readFileSync(join(MARKS, "NOTICE.md"), "utf8");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const bytesOf = (path: string) => readFileSync(join(PUBLIC, path));

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(b: Buffer): { width: number; height: number } {
  expect(b.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(b.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** What would make an SVG more than a picture: scripts, HTML, outside files or links, event handlers. */
function svgProblems(text: string): string[] {
  const problems: string[] = [];
  if (!/<svg\b[^>]*\bviewBox="[^"]+"/.test(text)) problems.push("no viewBox");
  if (/<script\b/i.test(text)) problems.push("script");
  if (/<foreignObject\b/i.test(text)) problems.push("foreignObject");
  if (/<(?:image|use|iframe|embed|object|a)\b/i.test(text)) problems.push("an element that loads or links");
  if (/\son[a-z]+\s*=/i.test(text)) problems.push("an event attribute");
  if (/\b(?:xlink:)?href\s*=\s*["'](?!#)/i.test(text)) problems.push("a link outside the file");
  if (/url\(\s*["']?(?!#)/i.test(text)) problems.push("a url() outside the file");
  if (/<!ENTITY|<!DOCTYPE/i.test(text)) problems.push("a DTD");
  if (/@import|javascript:|data:/i.test(text)) problems.push("an import or a script URL");
  return problems;
}

/** Every file under a folder, as a path from public/. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [`/${relative(PUBLIC, full).split("\\").join("/")}`];
  });
}

const manifests = MANIFESTS.map((m) => parseManifest(m));
const connectorFiles = manifests.flatMap((m) => (m.icon ? iconFiles(m.icon) : []));
const googleFiles = [GOOGLE_SIGN_IN.light, GOOGLE_SIGN_IN.dark];
const named = [...connectorFiles, ...googleFiles];

describe("the connector marks", () => {
  it.each(manifests.map((m) => [m.id, m]))("%s has its icon files on disk, in its own folder", (id, m) => {
    expect(m.icon, id).toBeTruthy();
    for (const file of iconFiles(m.icon!)) {
      expect(file.startsWith(`/marks/connectors/${id}/`), file).toBe(true);
      expect(statSync(join(PUBLIC, file)).isFile(), file).toBe(true);
    }
  });

  it.each(named.map((f) => [f]))("%s is what it says, safe to serve and at most 64 KB", (file) => {
    const b = bytesOf(file);
    expect(b.length, file).toBeLessThanOrEqual(64 * 1024);
    if (file.endsWith(".png")) {
      pngSize(b);
    } else {
      const text = b.toString("utf8");
      expect(text, file).toMatch(/<svg\b/);
      expect(svgProblems(text), file).toEqual([]);
    }
  });

  it("finds what an SVG must not carry", () => {
    expect(svgProblems('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>')).toEqual([]);
    expect(svgProblems('<svg viewBox="0 0 1 1" xmlns:xlink="http://www.w3.org/1999/xlink"><path fill="url(#a)"/></svg>')).toEqual([]);
    const bad = [
      '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 1 1" onload="alert(1)"></svg>',
      '<svg viewBox="0 0 1 1"><foreignObject><div/></foreignObject></svg>',
      '<svg viewBox="0 0 1 1"><image href="https://tracker.example/x.png"/></svg>',
      '<svg viewBox="0 0 1 1"><a xlink:href="javascript:alert(1)"><path d="M0 0"/></a></svg>',
      '<svg viewBox="0 0 1 1"><path style="fill:url(https://x.example/a)"/></svg>',
      '<svg><path d="M0 0"/></svg>',
    ];
    for (const svg of bad) expect(svgProblems(svg).length, svg).toBeGreaterThan(0);
  });

  it("are big enough to stay sharp on a 2x screen where they show", () => {
    // Square PNG icons fill at most a 32 pixel mark (a Listing's header).
    for (const file of connectorFiles.filter((f) => /\/icon\.png$/.test(f))) {
      const { width, height } = pngSize(bytesOf(file));
      expect(Math.max(width, height), file).toBeGreaterThanOrEqual(64);
    }
    for (const m of manifests) {
      const lockup = m.icon?.lockup;
      if (!lockup) continue;
      for (const file of [lockup.light, lockup.dark].filter((f): f is string => !!f)) {
        const png = pngSize(bytesOf(file));
        expect(png.width, file).toBeGreaterThanOrEqual(lockup.width * 2);
        // Shown at its own shape: the size on screen keeps the file's proportions.
        expect(Math.abs(png.width / png.height - lockup.width / lockup.height), file).toBeLessThan(0.05);
      }
    }
    for (const file of googleFiles) {
      const png = pngSize(bytesOf(file));
      expect(png.width, file).toBeGreaterThanOrEqual(GOOGLE_SIGN_IN.width * 2);
      expect(png.width / png.height).toBeCloseTo(GOOGLE_SIGN_IN.width / GOOGLE_SIGN_IN.height, 2);
    }
  });

  it("are all named by a manifest or the Google button, so nothing sits there unused", () => {
    const onDisk = filesUnder(MARKS).filter((f) => f !== "/marks/NOTICE.md");
    expect([...onDisk].sort()).toEqual([...new Set(named)].sort());
  });

  it("are each listed in the notice with their owner, an https source and a SHA-256 that matches", () => {
    for (const file of named) {
      const row = NOTICE.split("\n").find((line) => line.startsWith(`| \`${file.replace(/^\/marks\//, "")}\` |`));
      expect(row, file).toBeTruthy();
      const cells = row!.split("|").map((c) => c.trim());
      const [, , , owner, source, sha] = cells;
      expect(owner, file).toMatch(/^(?:Google LLC|Cloudflare, Inc\.|Vizzybl)$/);
      // Downloaded from its owner's own server, or a plain mark drawn here, which the notice says.
      expect(source, file).toMatch(/^(?:https:\/\/[a-z0-9.-]+\/|Drawn for YouGrow$)/);
      if (source === "Drawn for YouGrow") expect(NOTICE, file).toMatch(/drawn for YouGrow so its tile shows a mark/);
      expect(sha, file).toBe(`\`${createHash("sha256").update(bytesOf(file)).digest("hex")}\``);
    }
    for (const m of manifests) if (m.icon) expect(NOTICE, m.id).toContain(m.icon.owner);
    // It says what the marks are, and what they are not.
    expect(NOTICE).toContain("not covered by the GNU AGPL version 3");
    expect(NOTICE).toContain("doesn't mean any of these companies endorses or sponsors YouGrow");
    for (const owner of ["GitHub, Inc.", "GitLab Inc.", "LinkedIn Corporation", "X Corp."]) expect(NOTICE).toContain(owner);
  });
});
