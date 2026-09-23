import { describe, it, expect } from "vitest";
import { suggestRepos } from "./suggestRepos";

const r = (fullName: string) => ({ fullName, url: `https://github.com/${fullName}` });
const vizzyblAi = [r("vizzybl-ai/.github"), r("vizzybl-ai/claude-plugins"), r("vizzybl-ai/vizzybl")];

describe("suggestRepos", () => {
  it("ticks the repo matching the product's name, never GitHub's special repos", () => {
    expect(suggestRepos(vizzyblAi, "vizzybl-dev", [])).toEqual(["https://github.com/vizzybl-ai/vizzybl"]);
    expect(suggestRepos(vizzyblAi, "vizzybl.ai (staging)", [])).toEqual(["https://github.com/vizzybl-ai/vizzybl"]);
  });

  it("prefers the repos used last time for this product", () => {
    expect(suggestRepos(vizzyblAi, "vizzybl-dev", ["https://github.com/vizzybl-ai/claude-plugins.git"])).toEqual([
      "https://github.com/vizzybl-ai/claude-plugins",
    ]);
  });

  it("ticks the only repo, and nothing when it can't tell", () => {
    expect(suggestRepos([r("acme/web"), r("acme/.github")], "Something else", [])).toEqual(["https://github.com/acme/web"]);
    expect(suggestRepos([r("acme/web"), r("acme/api")], "Something else", [])).toEqual([]);
  });

  it("matches a word inside the repo name and respects the limit", () => {
    const repos = [r("acme/acme-web"), r("acme/acme-api"), r("acme/acme-worker"), r("acme/acme-docs")];
    expect(suggestRepos(repos, "Acme", [], 3)).toHaveLength(3);
  });
});
