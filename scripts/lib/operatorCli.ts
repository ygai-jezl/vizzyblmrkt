import { loadEnvConfig } from "@next/env";

/**
 * The shape the organisation scripts share (backfill-organisations.ts, set-plan.ts and
 * move-brand.ts), copied from scripts/grant-feature.ts and scripts/seed.ts:
 * - a real project by default, with any emulator variables removed, so a dev shell that exports
 *   them never sends a write to the wrong place;
 * - `--local` for the emulators only: it loads .env.local as the app does (values already in the
 *   shell win) and refuses unless the project is demo-* and FIRESTORE_EMULATOR_HOST is set;
 * - library code loaded with a dynamic import after this, so it reads the settled environment.
 *
 * It imports nothing from src/lib, on purpose.
 */

export interface OperatorArgs {
  /** The value after --name, or undefined. */
  get(name: string): string | undefined;
  /** Every value given for a flag that may repeat, split on commas too. */
  all(name: string): string[];
  has(name: string): boolean;
}

/**
 * Read argv. `valued` flags take the next word, `bare` ones take none. Anything else, or a valued
 * flag with no value, is refused, so a typo never runs as something else.
 */
export function parseOperatorArgs(tool: string, argv: readonly string[], valued: readonly string[], bare: readonly string[]): OperatorArgs {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? "";
    if (!word.startsWith("--")) refuse(tool, `Unexpected "${word}". Flags start with --.`);
    const name = word.slice(2);
    if (bare.includes(name)) {
      flags.add(name);
    } else if (valued.includes(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) refuse(tool, `--${name} needs a value.`);
      values.set(name, [...(values.get(name) ?? []), value]);
      i++;
    } else {
      refuse(tool, `Unknown flag --${name}. Flags: ${[...valued, ...bare].map((f) => `--${f}`).join(", ")}.`);
    }
  }
  return {
    get: (name) => values.get(name)?.at(-1),
    all: (name) => (values.get(name) ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean),
    has: (name) => flags.has(name),
  };
}

export function refuse(tool: string, message: string): never {
  console.error(`[${tool}] ${message}`);
  process.exit(1);
}

/**
 * Settle where the script writes, before any library code loads. Returns the project and a line
 * saying where that is.
 */
export function settleEnvironment(tool: string, local: boolean): { project: string; target: string } {
  if (local) {
    loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });
    const project = process.env.GOOGLE_CLOUD_PROJECT ?? "";
    if (!project.startsWith("demo-")) refuse(tool, `--local runs only against a demo-* project on the emulators; GOOGLE_CLOUD_PROJECT is ${project ? `"${project}"` : "unset"}.`);
    if (!process.env.FIRESTORE_EMULATOR_HOST) refuse(tool, "--local needs the emulators: start npm run local, or set FIRESTORE_EMULATOR_HOST.");
    return { project, target: `the emulator at ${process.env.FIRESTORE_EMULATOR_HOST}` };
  }
  // Never touch a local emulator (a dev shell may export these).
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? "";
  if (!project) refuse(tool, "Set GOOGLE_CLOUD_PROJECT=<your-project>, or pass --local for the emulators.");
  if (project.startsWith("demo-")) refuse(tool, `${project} only exists in the emulators: pass --local.`);
  return { project, target: "Firestore, with Application Default Credentials" };
}

/** Print the project and the settings the dry run reads, before anything else. */
export function printHeader(tool: string, where: { project: string; target: string }, settings: readonly string[]): void {
  console.log(`[${tool}] project=${where.project} (${where.target})`);
  for (const line of settings) console.log(`[${tool}] ${line}`);
}

/** "1 brand", "2 brands": a count and its noun. `many` defaults to the noun plus "s". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
