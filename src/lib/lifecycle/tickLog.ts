/**
 * The scheduler tick's own log lines: how long each job took, and how much memory the instance
 * holds once the tick is done. One memory line per instance every 2 minutes is cheap, and it
 * shows how memory splits between the JavaScript heap and everything outside it.
 *
 * Neither line carries personal data or brand ids: only job names, times and byte counts.
 */

const MIB = 1024 * 1024;

/** Bytes as MiB, to one decimal place. */
function mib(bytes: number): number {
  return Math.round((bytes / MIB) * 10) / 10;
}

/** "[tick] memory MiB rss=482 heapUsed=380.2 heapTotal=395 external=54.1 arrayBuffers=12.3" */
export function tickMemoryLine(m: NodeJS.MemoryUsage = process.memoryUsage()): string {
  return (
    `[tick] memory MiB rss=${mib(m.rss)} heapUsed=${mib(m.heapUsed)} heapTotal=${mib(m.heapTotal)}` +
    ` external=${mib(m.external)} arrayBuffers=${mib(m.arrayBuffers)}`
  );
}

export function logTickMemory(): void {
  console.log(tickMemoryLine());
}

/**
 * Runs one of the tick's jobs and logs "[tick] <job> <ms>ms" when it ends, whether it worked or
 * failed. `run` starts straight away, so jobs start in the order they are asked for. Each line
 * is written as its job ends: if an instance dies mid tick, the jobs with no line were running.
 */
export async function timedTickJob<T>(job: string, run: () => Promise<T>, clock: () => number = Date.now): Promise<T> {
  const t0 = clock();
  try {
    return await run();
  } finally {
    console.log(`[tick] ${job} ${clock() - t0}ms`);
  }
}
