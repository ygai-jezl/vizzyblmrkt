import { describe, expect, it } from "vitest";
import {
  describeClose,
  hasUserWords,
  microphoneProblem,
  tokenProblem,
} from "./voiceChat";

describe("hasUserWords", () => {
  it("is false for a chat in which the person said nothing", () => {
    expect(hasUserWords([])).toBe(false);
    expect(hasUserWords([{ role: "model", text: "Hi! What brought you here?" }])).toBe(false);
    expect(hasUserWords([{ role: "user", text: "" }])).toBe(false);
    expect(hasUserWords([{ role: "user", text: "  \n\t " }, { role: "model", text: "Hello?" }])).toBe(false);
  });

  it("is true once a turn of theirs has words, wherever it is", () => {
    expect(hasUserWords([{ role: "user", text: "Hi" }])).toBe(true);
    expect(hasUserWords([{ role: "model", text: "Hello!" }, { role: "user", text: " I want faster invoicing. " }])).toBe(true);
  });
});

describe("tokenProblem", () => {
  it("names why the token route gave no token", () => {
    expect(tokenProblem(503, "unavailable")).toBe("unavailable");
    expect(tokenProblem(409, "already_completed")).toBe("already_done");
    expect(tokenProblem(403, "no_signup")).toBe("start_failed");
    expect(tokenProblem(409, "waitlist_closed")).toBe("start_failed");
    expect(tokenProblem(200, undefined)).toBe("start_failed");
  });
});

describe("microphoneProblem", () => {
  const err = (name: string) => Object.assign(new Error("x"), { name });
  it("tells a refused microphone from a missing one", () => {
    expect(microphoneProblem(err("NotAllowedError"))).toBe("mic_blocked");
    expect(microphoneProblem(err("SecurityError"))).toBe("mic_blocked");
    expect(microphoneProblem(err("NotFoundError"))).toBe("no_mic");
    expect(microphoneProblem(err("OverconstrainedError"))).toBe("no_mic");
    expect(microphoneProblem(err("AbortError"))).toBe("start_failed");
    expect(microphoneProblem(undefined)).toBe("start_failed");
    // A browser's DOMException is not always an Error: its name is what counts.
    expect(microphoneProblem({ name: "NotAllowedError" })).toBe("mic_blocked");
  });
});

describe("describeClose", () => {
  it("keeps the code and Google's reason on one short line", () => {
    expect(describeClose({ code: 1008, reason: "models/x is not found\nfor API version v1alpha" })).toBe(
      "code 1008: models/x is not found for API version v1alpha",
    );
    expect(describeClose({ code: 1006, reason: "" })).toBe("code 1006");
    expect(describeClose(undefined)).toBe("code none");
    expect(describeClose({ code: 1011, reason: "r".repeat(500) })).toHaveLength("code 1011: ".length + 200);
  });
});
