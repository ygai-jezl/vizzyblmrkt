import { describe, expect, it } from "vitest";
import { launchChecklist } from "./launchChecklist";

const empty = { campaignId: "beta", signups: 0, welcomeLive: false, spotsPerReferral: 0, newslettersSent: 0 };

describe("launch checklist", () => {
  it("starts with four steps to do, in order, and adds the invite step when invites are on", () => {
    const steps = launchChecklist(empty);
    expect(steps.map((s) => s.key)).toEqual(["publish", "welcome", "referral", "content"]);
    expect(steps.every((s) => !s.done)).toBe(true);
    const withInvites = launchChecklist({ ...empty, invites: { lockText: "Connect your product first.", invited: 0, signedUp: 0 } });
    expect(withInvites.at(-1)).toMatchObject({
      key: "invite",
      done: false,
      detail: "Connect your product first.",
      href: "/admin/products",
    });
  });

  it("ticks steps off from real state and shows the invite numbers", () => {
    const steps = launchChecklist({
      campaignId: "beta",
      signups: 1204,
      welcomeLive: true,
      spotsPerReferral: 3,
      newslettersSent: 6,
      invites: { lockText: null, invited: 300, signedUp: 212 },
    });
    expect(steps.every((s) => s.done)).toBe(true);
    expect(steps.map((s) => s.detail)).toEqual([
      "1,204 people have joined",
      "Welcome & nurture is live",
      "Skip 3 places per friend",
      "6 newsletters sent to this waitlist",
      "300 invited · 212 signed up",
    ]);
    expect(steps.at(-1)?.href).toBe("/admin/launches/beta/invites");
  });

  it("names the site the waitlist is embedded on by its host", () => {
    expect(launchChecklist({ ...empty, embeddedAt: "https://fernlight.test/waitlist?x=1" })[0]).toMatchObject({
      done: true,
      detail: "Embedded on fernlight.test",
    });
  });
});
