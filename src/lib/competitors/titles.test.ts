import { describe, expect, it } from "vitest";
import { isFileHost } from "./hosts";
import { cleanTitle, decodeEntities } from "./titles";

describe("decodeEntities", () => {
  it("turns HTML codes back into characters", () => {
    expect(decodeEntities("Here&#x27;s what happened")).toBe("Here's what happened");
    expect(decodeEntities("Q&amp;A &#8220;quoted&#8221; &quot;plain&quot; &lt;b&gt;")).toBe("Q&A “quoted” \"plain\" <b>");
    expect(decodeEntities("&rsquo;&nbsp;&hellip;")).toBe("’ …");
  });

  it("leaves what isn't a code alone", () => {
    expect(decodeEntities("R&D & more &unknown; &#0;")).toBe("R&D & more &unknown; &#0;");
  });
});

describe("cleanTitle", () => {
  it("takes the site's name off the end", () => {
    expect(cleanTitle("Introducing Context Manager in Rival | Rival", ["Rival", "rival.test"])).toBe("Introducing Context Manager in Rival");
    expect(cleanTitle("How we price - Rival", ["Rival", "rival.test"])).toBe("How we price");
    expect(cleanTitle("How we price — Rival AI", ["Rival", "rival.test"])).toBe("How we price");
    expect(cleanTitle("How we price · tryrival", ["Rival", "tryrival.test"])).toBe("How we price");
  });

  it("decodes codes and tidies spaces too", () => {
    expect(cleanTitle("We ran a test. Here&#x27;s what happened |  Rival ", ["Rival"])).toBe("We ran a test. Here's what happened");
  });

  it("keeps a subtitle after a dash, and a long tail after a bar", () => {
    expect(cleanTitle("GEO vs SEO - what's the difference?", ["Rival", "rival.test"])).toBe("GEO vs SEO - what's the difference?");
    expect(cleanTitle("Rival Agents - Rival for agencies and the teams they serve", ["Rival"])).toBe("Rival Agents - Rival for agencies and the teams they serve");
    const long = "Prices | A long subtitle that runs well past forty characters in all";
    expect(cleanTitle(long, [])).toBe(long);
  });

  it("drops a short tail after a bar without names, as Google titles always did", () => {
    expect(cleanTitle("Whitening myths | Acme Dental")).toBe("Whitening myths");
    expect(cleanTitle("Prices | Opening hours | Acme Dental")).toBe("Prices | Opening hours");
    expect(cleanTitle("Whitening myths")).toBe("Whitening myths");
  });
});

describe("isFileHost", () => {
  it("knows hosts that only serve uploaded files", () => {
    expect(isFileHost("https://23651831.fs1.hubspotusercontent-na1.net/hubfs/x.pdf")).toBe(true);
    expect(isFileHost("https://d1234.cloudfront.net/a.png")).toBe(true);
    expect(isFileHost("https://research.example.org/report")).toBe(false);
    expect(isFileHost("not an address")).toBe(false);
  });
});
