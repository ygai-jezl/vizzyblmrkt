import { describe, expect, it } from "vitest";
import { accessDeniedMessage, signInNote, WORKSPACE_NOT_SET_UP_MESSAGE } from "./accessDenied";

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

describe("WORKSPACE_NOT_SET_UP_MESSAGE", () => {
  it("says the workspace isn't set up and names the setting that fixes it", () => {
    expect(WORKSPACE_NOT_SET_UP_MESSAGE).toContain("isn't set up yet");
    expect(WORKSPACE_NOT_SET_UP_MESSAGE).toContain("ADMIN_BOOTSTRAP_TENANT_ID");
  });
});

describe("signInNote", () => {
  it("keeps the Workspace wording when a sign-in domain is set", () => {
    expect(signInNote("yougrow.example")).toBe("Restricted to your Google Workspace accounts.");
  });

  it("points at the admin list otherwise", () => {
    for (const d of [undefined, "", "  "]) expect(signInNote(d)).toContain("admin list");
  });
});
