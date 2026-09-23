import { describe, it, expect } from "vitest";
import { isRepoSelected, repoPathFromUrl } from "./gitToken";

describe("gitToken repo selection", () => {
  it("normalizes repo URLs like the app does", () => {
    expect(repoPathFromUrl("github", "https://github.com/Acme/App.git")).toBe("acme/app");
    expect(repoPathFromUrl("gitlab", "https://gitlab.com/g/s/p/-/tree/x")).toBe("g/s/p");
    expect(repoPathFromUrl("github", "https://evil.com/acme/app")).toBeNull();
  });

  it("uses the token for any repo on a legacy connection", () => {
    expect(isRepoSelected("github", undefined, "https://github.com/a/b")).toBe(true);
  });

  it("uses the token only for selected repos", () => {
    const repos = [{ fullPath: "acme/app" }];
    expect(isRepoSelected("github", repos, "https://github.com/acme/app")).toBe(true);
    expect(isRepoSelected("github", repos, "https://github.com/acme/secret")).toBe(false);
    expect(isRepoSelected("gitlab", [], "https://gitlab.com/g/p")).toBe(false);
  });
});
