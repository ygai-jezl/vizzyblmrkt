// Questions on the terminal for `npm run selfhost`: plain answers, y/N confirmations and
// hidden input for keys. Reads stdin line by line (so answers can also be piped in, as the
// tests do). Hidden input needs a real terminal. Node built-ins only.

/**
 * @param {{ input?: NodeJS.ReadStream, output?: NodeJS.WriteStream }} [io]
 */
export function createPrompter(io = {}) {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  let buffer = "";
  let ended = false;
  let started = false;
  /** @type {{ take: () => string | null | undefined, resolve: (v: string | null) => void }[]} */
  const waiters = [];

  const flush = () => {
    while (waiters.length) {
      const w = waiters[0];
      const res = w.take();
      if (res === undefined) return;
      waiters.shift();
      w.resolve(res);
    }
  };
  const start = () => {
    if (started) return;
    started = true;
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      buffer += chunk;
      flush();
    });
    input.on("end", () => {
      ended = true;
      flush();
    });
    input.resume();
  };
  const takeLine = () => {
    const m = buffer.match(/\r\n|\n|\r/);
    if (m && m.index !== undefined) {
      const line = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      return line;
    }
    if (ended) {
      if (buffer) {
        const rest = buffer;
        buffer = "";
        return rest;
      }
      return null;
    }
    return undefined;
  };
  const nextLine = () =>
    new Promise((resolve) => {
      start();
      waiters.push({ take: takeLine, resolve });
      flush();
    });

  return {
    /** An answer, or `fallback` for an empty answer or no input. */
    async ask(question, fallback = "") {
      output.write(`${question}${fallback ? ` [${fallback}]` : ""}: `);
      const line = await nextLine();
      if (line === null) output.write("\n");
      const answer = (line ?? "").trim();
      return answer || fallback;
    },
    /** y/N: true only for an explicit yes. */
    async confirm(question) {
      output.write(`${question} [y/N]: `);
      const line = await nextLine();
      if (line === null) output.write("\n");
      return /^y(es)?$/i.test((line ?? "").trim());
    },
    /** True when hidden input is possible (a real terminal). */
    canHide() {
      return Boolean(input.isTTY && typeof input.setRawMode === "function");
    },
    /**
     * Read a value without echoing it. Returns null without a terminal or on Ctrl-D.
     * Ctrl-C stops the program.
     */
    async askHidden(question) {
      if (!this.canHide()) return null;
      start();
      output.write(`${question}: `);
      input.setRawMode(true);
      let value = "";
      const take = () => {
        while (buffer.length) {
          const ch = buffer[0];
          buffer = buffer.slice(1);
          if (ch === "\r" || ch === "\n") return value;
          if (ch === "\u0003") {
            input.setRawMode(false);
            output.write("\n");
            process.exit(130);
          }
          if (ch === "\u0004") return value || null;
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " ") value += ch;
        }
        return ended ? value || null : undefined;
      };
      const result = await new Promise((resolve) => {
        waiters.push({ take, resolve });
        flush();
      });
      input.setRawMode(false);
      output.write("\n");
      return result;
    },
    /** Let the process exit once nothing more will be asked. */
    close() {
      if (started) {
        input.pause();
        input.removeAllListeners("data");
        input.removeAllListeners("end");
      }
    },
  };
}
