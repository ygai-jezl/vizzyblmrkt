import { afterEach, describe, expect, it, vi } from "vitest";
import { logTickMemory, tickMemoryLine, timedTickJob } from "./tickLog";

const MIB = 1024 * 1024;

afterEach(() => vi.restoreAllMocks());

describe("the tick's memory line", () => {
  it("gives every figure in MiB to one decimal place", () => {
    const line = tickMemoryLine({
      rss: 482 * MIB,
      heapUsed: 380.24 * MIB,
      heapTotal: 395 * MIB,
      external: 54.06 * MIB,
      arrayBuffers: 12.36 * MIB,
    });
    expect(line).toBe("[tick] memory MiB rss=482 heapUsed=380.2 heapTotal=395 external=54.1 arrayBuffers=12.4");
  });

  it("reads this process's memory and writes one line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logTickMemory();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(
      /^\[tick\] memory MiB rss=\d+(\.\d)? heapUsed=\d+(\.\d)? heapTotal=\d+(\.\d)? external=\d+(\.\d)? arrayBuffers=\d+(\.\d)?$/,
    );
  });
});

describe("a timed tick job", () => {
  it("returns what the job returns and logs its name and time", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const times = [1_000, 1_250];
    const clock = () => times.shift() ?? 0;
    await expect(timedTickJob("search", async () => ({ scanned: true }), clock)).resolves.toEqual({ scanned: true });
    expect(log.mock.calls).toEqual([["[tick] search 250ms"]]);
  });

  it("logs a job that fails too, and passes its error on", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const times = [5_000, 5_040];
    const clock = () => times.shift() ?? 0;
    await expect(timedTickJob("signals", async () => Promise.reject(new Error("down")), clock)).rejects.toThrow("down");
    expect(log.mock.calls).toEqual([["[tick] signals 40ms"]]);
  });

  it("starts the job straight away, before the caller's next line runs", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const order: string[] = [];
    void timedTickJob("autopilot", async () => {
      order.push("job");
    });
    order.push("caller");
    expect(order).toEqual(["job", "caller"]);
  });
});
