import { describe, expect, it } from "vitest";
import { isTestRecipient } from "./policy";
import { looksLikeEmail, splitTestUsers } from "./testRecipients";

describe("a journey's test list", () => {
  it("splits one typed list into user ids and email addresses", () => {
    expect(splitTestUsers(["fS1iVuHl82g65342dMn46leZjvA2", " Alex@Example.com ", "", "user_123", "sam@example.co.uk"])).toEqual({
      userIds: ["fS1iVuHl82g65342dMn46leZjvA2", "user_123"],
      emails: ["Alex@Example.com", "sam@example.co.uk"],
    });
    expect(looksLikeEmail("not-an-email@")).toBe(false);
  });

  it("matches by user id, by address, and by an address saved in the user-id list", () => {
    const user = { externalUserId: "fS1iVuHl82g65342dMn46leZjvA2", email: "Tester@Gmail.com" };
    const list = (userIds: string[], emails: string[] = []) => ({ testRecipients: { userIds, emails } });
    expect(isTestRecipient(list(["fS1iVuHl82g65342dMn46leZjvA2"]), user)).toBe(true);
    expect(isTestRecipient(list([], ["tester@gmail.com"]), user)).toBe(true);
    expect(isTestRecipient(list(["tester@gmail.com", "someone@gmail.com"]), user)).toBe(true); // saved in the wrong box
    expect(isTestRecipient(list(["someone@gmail.com", "user_9"]), user)).toBe(false);
    expect(isTestRecipient(list(["tester@gmail.com"]), { externalUserId: "u", email: null })).toBe(false);
  });
});
