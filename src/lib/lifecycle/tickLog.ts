/**
 * The scheduler tick's own log lines: how long each job took, and how much memory the instance
 * holds once the tick is done. There is one memory line per scheduler tick, from the instance
 * that served it, which is cheap. It shows how memory splits between the JavaScript heap and
 * everything outside it. Instances that only serve user traffic never write one, so the lines
 * sample only the instances that took a tick.
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

/**
 * Writes the memory line. It is best effort: `process.memoryUsage()` can throw (for example when
 * the instance runs out of file handles), and a finished tick must still return what it did.
 */
export function logTickMemory(read: () => NodeJS.MemoryUsage = () => process.memoryUsage()): void {
  try {
    console.log(tickMemoryLine(read()));
  } catch {
    // The memory line is best effort.
  }
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
