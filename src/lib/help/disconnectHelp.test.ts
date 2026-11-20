import { afterEach, describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { pageMarkdown } from "@/lib/developers/agentDocs";
import { helpPageMarkdown } from "./agentFiles";

// Connected accounts › Disconnect an account says what Disconnect does in each switch
// state: with revoke off it says how to cancel access on the service; with revoke on it
// names GitLab and an older GitHub connection, and X only when the X switch is on too.
// help.test.ts reads the page in one state, so the other states are checked here, with
// the Disconnect lines on /developers/connect-your-code.
afterEach(() => vi.unstubAllEnvs());

function disconnectSection(revoke: string, revokeX: string): string {
  vi.stubEnv("CONNECTOR_REVOKE_ENABLED", revoke);
  vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", revokeX);
  const md = helpPageMarkdown("connected-accounts", "https://app.example.com")!;
  const start = md.indexOf("## Disconnect an account");
  expect(start).toBeGreaterThanOrEqual(0);
  return md.slice(start, md.indexOf("\n## ", start + 1));
}

const OFF =
  "Disconnect removes the connection from YouGrow. To cancel YouGrow's access on the service too, remove YouGrow in that service's settings. That stops it for every brand connected with the same account.";
const GITHUB_APP =
  "It never removes the YouGrow app from GitHub, because other brands may use the same installation. You can uninstall it on GitHub, but that stops it for every brand that uses it.";

describe("Connected accounts: Disconnect an account", () => {
  it("both switches off: removing YouGrow on the service stops it for every brand", () => {
    const text = disconnectSection("", "");
    expect(text).toContain(OFF);
    expect(text).not.toContain("also cancels");
  });

  it("the X switch alone reads as off", () => {
    expect(disconnectSection("false", "true")).toContain(OFF);
  });

  it("the revoke switch on and the X switch off: names GitLab and an older GitHub connection, not X", () => {
    const text = disconnectSection("true", "");
    expect(text).toContain(
      "For GitLab and an older GitHub connection it also cancels YouGrow's access on that service.",
    );
    expect(text).toContain(GITHUB_APP);
    expect(text).toContain(
      "For LinkedIn or X, you can remove YouGrow in that service's settings, but that stops it for every brand connected with the same account.",
    );
    expect(text).not.toContain("GitLab, X and");
  });

  it("both switches on: names X too, and LinkedIn is still left to its own settings", () => {
    const text = disconnectSection("true", "true");
    expect(text).toContain("For GitLab, X and an older GitHub connection it also cancels YouGrow's access on that service.");
    expect(text).toContain(GITHUB_APP);
    expect(text).toContain(
      "For LinkedIn, you can remove YouGrow in your LinkedIn settings, but that stops it for every brand connected with the same LinkedIn account.",
    );
  });

  it.each([
    ["", ""],
    ["true", ""],
    ["true", "true"],
  ])("keeps to house style with revoke %j and X %j", (revoke, revokeX) => {
    const text = disconnectSection(revoke, revokeX);
    expect(dashesIn(text)).toEqual([]);
    expect(aiTellsIn(text)).toEqual([]);
    expect(text).not.toMatch(/ {2}|\[object Object\]|undefined/);
  });
});

describe("/developers/connect-your-code: Disconnect", () => {
  const page = (revoke: string) => {
    vi.stubEnv("CONNECTOR_REVOKE_ENABLED", revoke);
    return pageMarkdown("connect-your-code", "https://app.example.com")!;
  };
  const NEVER_UNINSTALLS =
    "It never uninstalls the app from GitHub, because other brands may use the same installation.";
  const UNINSTALL_ALL = "That stops it for every brand that uses the same installation.";
  const OLDER_GITHUB = "For an older GitHub connection made before the app, it also cancels that connection's access on GitHub.";
  const GITLAB_ON = "removes the connection and also cancels YouGrow's access on GitLab.";
  const GITLAB_OFF =
    "To cancel YouGrow's access on GitLab too, revoke YouGrow in your GitLab user settings under **Applications**. That stops it for every brand connected with the same GitLab account.";

  it("switch off: Disconnect stays on our side, and says how to cancel access on GitLab", () => {
    const md = page("");
    expect(md).toContain(NEVER_UNINSTALLS);
    expect(md).toContain(UNINSTALL_ALL);
    expect(md).toContain(GITLAB_OFF);
    expect(md).not.toContain(OLDER_GITHUB);
    expect(md).not.toContain(GITLAB_ON);
  });

  it("switch on: Disconnect also cancels access at GitLab and on an older GitHub connection", () => {
    const md = page("true");
    expect(md).toContain(NEVER_UNINSTALLS);
    expect(md).toContain(UNINSTALL_ALL);
    expect(md).toContain(OLDER_GITHUB);
    expect(md).toContain(GITLAB_ON);
    expect(md).not.toContain(GITLAB_OFF);
  });

  it("the new lines keep to house style", () => {
    for (const line of [NEVER_UNINSTALLS, UNINSTALL_ALL, OLDER_GITHUB, GITLAB_ON, GITLAB_OFF]) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });

  it.each(["", "true"])("the whole page has no dashes as punctuation, with revoke %j", (revoke) => {
    vi.stubEnv("GIT_REPO_SELECTION_ENABLED", "");
    expect(dashesIn(page(revoke))).toEqual([]);
    vi.stubEnv("GIT_REPO_SELECTION_ENABLED", "true");
    expect(dashesIn(page(revoke))).toEqual([]);
  });

  it("says where the reconnect line shows, with no doubled stop", () => {
    const md = page("");
    expect(md).toContain(
      "shows **This connection needs reconnecting.** next to GitLab, an admin presses **Reconnect**.",
    );
    expect(md).not.toMatch(/reconnecting\.\*\*,/);
  });
});
