import { redactSecrets } from "./redact";

/**
 * Read-only view over the files of one or more cloned repos, for the analysis
 * agent's tools. Everything it returns is redacted and size-capped. Nothing here
 * can write, execute, or reach the network.
 */

export interface RepoFile {
  /** Repo label, e.g. "web" — a path prefix when several repos are analysed. */
  repo: string;
  path: string;
  text: string;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

const MAX_PATTERN = 200;
const MAX_LINE = 400;
const READ_MAX_LINES = 250;

function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`);
}

/** Refuse patterns that can backtrack catastrophically, e.g. (a+)+. */
function safePattern(pattern: string, ignoreCase: boolean): RegExp | null {
  if (!pattern || pattern.length > MAX_PATTERN) return null;
  if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(pattern)) return null;
  try {
    return new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    return null;
  }
}

export class RepoReader {
  private readonly files = new Map<string, string>();

  constructor(files: RepoFile[]) {
    const multi = new Set(files.map((f) => f.repo)).size > 1;
    for (const f of files) this.files.set(multi ? `${f.repo}/${f.path}` : f.path, f.text);
  }

  get size(): number {
    return this.files.size;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** The redacted text of a file (what the model saw), or null. */
  redactedText(path: string): string | null {
    const t = this.files.get(path);
    return t === undefined ? null : redactSecrets(t);
  }

  /** Folders (two levels deep) with their file counts — a cheap map of the codebase. */
  overview(maxLines = 80): string {
    const counts = new Map<string, number>();
    for (const p of this.files.keys()) {
      const parts = p.split("/");
      const dir = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : "./";
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxLines)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, n]) => `${d} (${n})`)
      .join("\n");
  }

  list(glob?: string, limit = 300): { total: number; paths: string[] } {
    const re = glob ? globToRegExp(glob) : null;
    const all = [...this.files.keys()].filter((p) => !re || re.test(p)).sort();
    return { total: all.length, paths: all.slice(0, Math.min(limit, 500)) };
  }

  grep(pattern: string, opts: { glob?: string; ignoreCase?: boolean; max?: number } = {}): { matches: GrepMatch[]; truncated: boolean; error?: string } {
    const re = safePattern(pattern, opts.ignoreCase ?? true);
    if (!re) return { matches: [], truncated: false, error: "invalid_or_unsafe_pattern" };
    const scope = opts.glob ? globToRegExp(opts.glob) : null;
    const max = Math.min(opts.max ?? 60, 150);
    const matches: GrepMatch[] = [];
    for (const [path, text] of [...this.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (scope && !scope.test(path)) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!.slice(0, 2000);
        if (re.test(line)) {
          matches.push({ path, line: i + 1, text: redactSecrets(line.trim()).slice(0, MAX_LINE) });
          if (matches.length >= max) return { matches, truncated: true };
        }
      }
    }
    return { matches, truncated: false };
  }

  read(path: string, startLine = 1, endLine?: number): { path: string; startLine: number; endLine: number; totalLines: number; text: string } | { error: string } {
    const raw = this.files.get(path);
    if (raw === undefined) return { error: "file_not_found" };
    const lines = redactSecrets(raw).split("\n");
    const start = Math.max(1, Math.floor(startLine));
    const end = Math.min(lines.length, Math.floor(endLine ?? start + READ_MAX_LINES - 1), start + READ_MAX_LINES - 1);
    const text = lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}: ${l.slice(0, 1000)}`)
      .join("\n");
    return { path, startLine: start, endLine: end, totalLines: lines.length, text };
  }
}

export const __test = { globToRegExp, safePattern };
