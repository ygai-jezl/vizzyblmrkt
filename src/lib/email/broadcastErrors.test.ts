import { describe, expect, it } from "vitest";
import { broadcastErrorText } from "./broadcastErrors";

describe("why a broadcast didn't send", () => {
  it("names the launch, as the help page quotes today", () => {
    expect(broadcastErrorText("no_audience_segment_for_launch", "weekly")).toMatch(/^Nobody has joined this launch's weekly newsletter yet, so nothing was sent\./);
    expect(broadcastErrorText("no_audience_segment_for_launch", "launch")).toMatch(/^Nobody from this launch is in your Mailchimp audience yet/);
    expect(broadcastErrorText("launch_archived")).toBe("This launch is archived, so nothing was sent.");
  });

  it("names the idea while launches are called ideas", () => {
    expect(broadcastErrorText("no_audience_segment_for_launch", "weekly", true)).toBe(
      "Nobody has joined this idea's weekly newsletter yet, so nothing was sent. People join when they reach the weekly newsletter step of its welcome journey.",
    );
    expect(broadcastErrorText("no_audience_segment_for_launch", "launch", true)).toMatch(/^Nobody from this idea is in your Mailchimp audience yet/);
    expect(broadcastErrorText("launch_archived", null, true)).toBe("This idea is archived, so nothing was sent.");
  });

  it("say the rest the same way in both words", () => {
    for (const code of ["mailchimp_config:shared_not_configured", "must_be_future", "not_schedulable", "nope", null]) {
      expect(broadcastErrorText(code, "weekly", true)).toBe(broadcastErrorText(code, "weekly"));
      expect(broadcastErrorText(code, "weekly", true)).not.toMatch(/\blaunch/i);
    }
  });
});
