import { describe, expect, it } from "vitest";
import { accessDeniedMessage } from "./accessDenied";

describe("accessDeniedMessage", () => {
  it("names the Workspace domain when one is set", () => {
    expect(accessDeniedMessage("yougrow.example")).toBe("Access denied. Sign in with your @yougrow.example account.");
  });

  it("is neutral without a domain, and says how to get access", () => {
    for (const hd of [undefined, "", "  "]) {
      const message = accessDeniedMessage(hd);
      expect(message).toContain("isn't on the admin list");
      expect(message).toContain("ADMIN_ALLOWED_EMAILS");
      expect(message).not.toContain("@");
    }
  });
});
