import { describe, it, expect } from "vitest";
import { validateIngestUrl } from "./url";

describe("validateIngestUrl", () => {
  it("accepts a public https docs url", () => {
    const r = validateIngestUrl("https://docs.example.com/guide", "docs_url");
    expect(r.ok).toBe(true);
  });

  it("rejects non-https", () => {
    expect(validateIngestUrl("http://example.com", "docs_url")).toMatchObject({
      ok: false,
      reason: "scheme_not_https",
    });
  });

  it("rejects an unparseable url", () => {
    expect(validateIngestUrl("not a url", "website")).toMatchObject({ ok: false, reason: "invalid_url" });
  });

  it("blocks loopback / private / metadata hosts", () => {
    for (const u of [
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest",
      "https://10.0.0.5/x",
      "https://192.168.1.1/x",
      "https://172.16.4.4/x",
      "https://foo.internal/x",
    ]) {
      expect(validateIngestUrl(u, "website")).toMatchObject({ ok: false, reason: "host_blocked" });
    }
  });

  it("pins github/gitlab sources to their hosts", () => {
    expect(validateIngestUrl("https://github.com/org/repo", "github").ok).toBe(true);
    expect(validateIngestUrl("https://gitlab.com/org/repo", "gitlab").ok).toBe(true);
    expect(validateIngestUrl("https://evil.com/org/repo", "github")).toMatchObject({
      ok: false,
      reason: "host_not_allowed",
    });
    // A github URL submitted under the gitlab source is rejected.
    expect(validateIngestUrl("https://github.com/org/repo", "gitlab")).toMatchObject({
      ok: false,
      reason: "host_not_allowed",
    });
  });
});
