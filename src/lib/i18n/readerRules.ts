/**
 * The 10 reader rule (LANGUAGE_READERS_ENABLED), safe for the browser: a language other than the
 * default gets its own version of something once it has at least the brand's number of readers.
 */

/** A language gets its own version once it has this many readers, unless the brand sets its own number. */
export const DEFAULT_MIN_READERS = 10;
export const MAX_MIN_READERS = 1000;

/** Whether a language has enough readers for its own version, and how many more it needs if not. */
export function versionReadiness(readers: number, minReaders: number): { ready: boolean; more: number } {
  const more = Math.max(0, minReaders - readers);
  return { ready: more === 0, more };
}
