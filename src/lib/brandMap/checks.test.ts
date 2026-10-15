import { describe, expect, it } from "vitest";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { checkDecided } from "./checks";

const map = (over: Record<string, unknown>) => BrandMapDecidedSchema.parse(over);
const paths = (d: ReturnType<typeof map>) => checkDecided(d, { ownSites: ["acme.example"] }).map((i) => i.path);

describe("brand map checks", () => {
  it("passes a tidy map", () => {
    const d = map({
      identity: {
        name: "Acme",
        site: "https://acme.example",
        profiles: [{ url: "https://www.linkedin.com/company/acme-example", source: "site" }],
        categorySameAs: [{ url: "https://www.wikidata.org/wiki/Q123", source: "wikidata" }],
        avoid: [{ term: "GEO tool", useInstead: "AI visibility tracking" }],
      },
      subjects: [{ id: "sub_aaaaaaaa", name: "Share of voice", home: "https://www.acme.example/sov", questions: [{ id: "q_aaaaaaaa", text: "What is it?" }] }],
      names: [
        { id: "n_aaaaaaaa", name: "Rivalco", kind: "alternative", aliases: ["Rivalco Inc"], sameAs: [{ url: "https://en.wikipedia.org/wiki/Rivalco", source: "wikipedia" }] },
      ],
    });
    expect(checkDecided(d, { ownSites: ["acme.example"] })).toEqual([]);
  });

  it("refuses a home page off the brand's site, and a profile on it", () => {
    const d = map({
      subjects: [{ id: "sub_aaaaaaaa", name: "Share of voice", home: "https://someone-else.example/sov" }],
      names: [{ id: "n_aaaaaaaa", name: "Acme Pulse", kind: "product", home: "https://someone-else.example/pulse" }],
      identity: { profiles: [{ url: "https://acme.example/about", source: "manual" }] },
    });
    expect(paths(d)).toEqual(["subjects.0.home", "names.0.home", "identity.profiles.0"]);
  });

  it("refuses one spelling for two names, and a name both used and avoided", () => {
    const d = map({
      identity: { avoid: [{ term: "rivalco" }] },
      names: [
        { id: "n_aaaaaaaa", name: "Rivalco", kind: "alternative" },
        { id: "n_bbbbbbbb", name: "Rival Co", kind: "alternative", aliases: ["RIVALCO"] },
      ],
    });
    expect(paths(d)).toEqual(["names.1.aliases.0", "identity.avoid.0.term"]);
  });

  it("refuses a link that is not what it says it is, and a repeated id", () => {
    const d = map({
      names: [
        { id: "n_aaaaaaaa", name: "Rivalco", kind: "alternative", sameAs: [{ url: "https://www.wikidata.org/wiki/Special:Search", source: "wikidata" }] },
        { id: "n_aaaaaaaa", name: "Other", kind: "alternative" },
      ],
    });
    expect(paths(d)).toEqual(["names.0.sameAs.0", "names.1.id"]);
  });
});
