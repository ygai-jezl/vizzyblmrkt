import { afterEach, describe, expect, it, vi } from "vitest";

// The palette's area keywords are read at import, so each case imports a fresh copy.
async function keywords() {
  vi.resetModules();
  return (await import("./CommandPalette")).KEYWORDS;
}

describe("⌘K keywords", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("find Settings by Connections, its tab's name, and by Integrations, its old one", async () => {
    for (const plans of ["false", "true"]) {
      vi.stubEnv("NEXT_PUBLIC_PLANS_ENABLED", plans);
      const settings = (await keywords()).settings ?? [];
      expect(settings, plans).toEqual(expect.arrayContaining(["connections", "connected data", "integrations"]));
    }
  });
});
