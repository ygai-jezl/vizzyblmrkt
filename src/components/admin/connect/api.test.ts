import { describe, expect, it } from "vitest";
import { errorText } from "./api";

describe("an admin API error in words", () => {
  it("names a launch, or an idea while the words are on", () => {
    expect(errorText({ error: "campaign_not_found" })).toBe("That launch doesn't exist.");
    expect(errorText({ error: "campaign_not_found" }, true)).toBe("That idea doesn't exist.");
    expect(errorText({ error: "invites_locked" }, true)).toBe("Invites are locked for this idea.");
  });

  it("says the rest the same way in both words", () => {
    expect(errorText({ error: "wave_not_found" }, true)).toBe(errorText({ error: "wave_not_found" }));
    expect(errorText({ error: "send_failed", detail: "timeout" }, true)).toBe("The email couldn't be sent. (timeout)");
    expect(errorText(null, true)).toBe("Something went wrong.");
  });
});
