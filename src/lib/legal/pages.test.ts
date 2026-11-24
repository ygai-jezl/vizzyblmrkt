import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasPlaceholder, legalLinks, legalPage, legalTitle } from "./pages";

let root: string;

function write(slug: string, text: string) {
  writeFileSync(path.join(root, "legal", `${slug}.md`), text);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "legal-"));
  mkdirSync(path.join(root, "legal"));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.stubEnv("LEGAL_PAGES_ENABLED", "true");
  vi.stubEnv("LEGAL_DPA_ENABLED", "true");
  write("privacy", "# Privacy Policy\n\nWe keep your data safe. See [terms](/terms).\n");
  write("terms", "# Terms of Service\n\nBe nice.\n");
  write("dpa", "# Data Processing Agreement\n\nClauses.\n");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("legalPage", () => {
  it("returns the text when the switch is on and the file is complete", () => {
    expect(legalPage("privacy")).toContain("We keep your data safe");
  });

  it("is null with the switch off: the app behaves as before", () => {
    vi.stubEnv("LEGAL_PAGES_ENABLED", "false");
    expect(legalPage("privacy")).toBeNull();
    expect(legalPage("dpa")).toBeNull();
    expect(legalLinks()).toEqual([]);
  });

  it("keeps the DPA off until its own switch is on", () => {
    vi.stubEnv("LEGAL_DPA_ENABLED", "");
    expect(legalPage("dpa")).toBeNull();
    expect(legalPage("terms")).not.toBeNull();
  });

  it("needs LEGAL_PAGES_ENABLED for the DPA too", () => {
    vi.stubEnv("LEGAL_PAGES_ENABLED", "");
    expect(legalPage("dpa")).toBeNull();
  });

  it("is null when the file is missing or empty", () => {
    rmSync(path.join(root, "legal", "terms.md"));
    write("privacy", "  \n");
    expect(legalPage("terms")).toBeNull();
    expect(legalPage("privacy")).toBeNull();
  });

  it("is null while a placeholder is left", () => {
    write("terms", "# Terms\n\nRun by [Company legal name].\n");
    expect(legalPage("terms")).toBeNull();
  });
});

describe("legalLinks", () => {
  it("lists only the pages that show, in footer order", () => {
    rmSync(path.join(root, "legal", "terms.md"));
    expect(legalLinks()).toEqual([
      { href: "/privacy", label: "Privacy" },
      { href: "/dpa", label: "DPA" },
    ]);
  });
});

describe("hasPlaceholder", () => {
  it("finds bracketed blanks", () => {
    expect(hasPlaceholder("Last updated: [date]")).toBe(true);
    expect(hasPlaceholder("a cap of [£100]")).toBe(true);
  });

  it("ignores links and task boxes", () => {
    expect(hasPlaceholder("See [our terms](https://example.com/terms).")).toBe(false);
    expect(hasPlaceholder("- [ ] open\n- [x] done")).toBe(false);
    expect(hasPlaceholder("Plain text.")).toBe(false);
  });
});

describe("legalTitle", () => {
  it("uses the first heading, else the label", () => {
    expect(legalTitle("terms", "# Terms of Service\n\nx")).toBe("Terms of Service");
    expect(legalTitle("dpa", "No heading")).toBe("DPA");
  });
});
