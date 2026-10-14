import { describe, expect, it } from "vitest";
import { BrandMapChangeSchema, BrandMapDecidedSchema, type BrandMapChange } from "@/lib/types/brandMap";
import { applyChange, applyChanges, changeKey, describeChange, emptyDecided, findName, fold, isSatisfied } from "./changes";

const change = (c: unknown): BrandMapChange => BrandMapChangeSchema.parse(c);
let n = 0;
const ids = (p: "sub" | "q" | "n") => `${p}_id${String((n += 1)).padStart(6, "0")}`;

describe("brand map changes", () => {
  it("folds two spellings of one name together, in any script", () => {
    expect(fold("  AI-Visibility   Tracking!")).toBe("ai visibility tracking");
    expect(fold("Ｒｉｖａｌｃｏ")).toBe("rivalco");
    expect(fold("Größe")).toBe("größe");
  });

  it("keys a proposal the same way however it is spelled", () => {
    expect(changeKey(change({ type: "add_name", name: "Rivalco", kind: "alternative" }))).toBe(
      changeKey(change({ type: "add_name", name: "  rivalco ", kind: "product" })),
    );
    expect(changeKey(change({ type: "add_profile", url: "https://www.linkedin.com/company/acme/?utm_source=x" }))).toBe(
      changeKey(change({ type: "add_profile", url: "https://www.linkedin.com/company/acme" })),
    );
    expect(changeKey(change({ type: "add_question", subject: "Share of voice", text: "What is it?" }))).toBe("q:share of voice:what is it");
  });

  it("refuses a change that carries anything it does not name", () => {
    expect(BrandMapChangeSchema.safeParse({ type: "add_name", name: "Rivalco", kind: "alternative", home: "https://x.example" }).success).toBe(false);
    expect(BrandMapChangeSchema.safeParse({ type: "add_name", name: "Two\nlines", kind: "alternative" }).success).toBe(false);
  });

  it("applies each kind of change to a copy, and says when it cannot", () => {
    const start = emptyDecided();
    const { decided, issues } = applyChanges(
      start,
      [
        change({ type: "set_identity", field: "name", value: "Acme" }),
        change({ type: "set_identity", field: "category", value: "AI visibility tracking" }),
        change({ type: "set_identity", field: "site", value: "https://acme.example" }),
        change({ type: "add_is_not", text: "A general SEO suite" }),
        change({ type: "add_avoid", term: "GEO tool", useInstead: "AI visibility tracking" }),
        change({ type: "add_profile", url: "https://www.linkedin.com/company/acme-example" }),
        // The question arrives before its subject: the subject comes with it.
        change({ type: "add_question", subject: "Share of voice", text: "What is share of voice?", intent: "definition" }),
        change({ type: "add_subject", name: "Share of voice" }),
        change({ type: "add_name", name: "Rivalco", kind: "alternative" }),
        change({ type: "add_alias", name: "Rivalco", alias: "Rivalco Inc" }),
        change({ type: "set_home", target: "subject", name: "share of voice", url: "https://acme.example/share-of-voice" }),
        change({ type: "add_alias", name: "Nobody", alias: "Noone" }),
      ],
      ids,
    );
    expect(start).toEqual(emptyDecided()); // never changed in place
    expect(issues).toEqual(["“Nobody” is not on the map"]);
    expect(decided.identity).toMatchObject({
      name: "Acme",
      category: "AI visibility tracking",
      site: "https://acme.example",
      isNot: ["A general SEO suite"],
      avoid: [{ term: "GEO tool", useInstead: "AI visibility tracking" }],
      profiles: [{ url: "https://www.linkedin.com/company/acme-example", source: "site", confirmedAt: "" }],
    });
    expect(decided.subjects).toHaveLength(1);
    expect(decided.subjects[0]).toMatchObject({ name: "Share of voice", home: "https://acme.example/share-of-voice" });
    expect(decided.subjects[0]!.questions).toMatchObject([{ text: "What is share of voice?", intent: "definition" }]);
    expect(findName(decided, "rivalco inc")?.name).toBe("Rivalco");
    expect(BrandMapDecidedSchema.safeParse(decided).success).toBe(true);
  });

  it("knows a change that is already true of the map", () => {
    const d = BrandMapDecidedSchema.parse({
      identity: { name: "Acme", avoid: [{ term: "GEO tool" }] },
      names: [{ id: "n_aaaaaaaa", name: "Rivalco", kind: "alternative", aliases: ["Rivalco Inc"] }],
    });
    expect(isSatisfied(d, change({ type: "add_name", name: "RIVALCO INC", kind: "alternative" }))).toBe(true);
    expect(isSatisfied(d, change({ type: "add_avoid", term: "geo tool" }))).toBe(true);
    expect(isSatisfied(d, change({ type: "set_identity", field: "name", value: "acme" }))).toBe(true);
    expect(isSatisfied(d, change({ type: "add_alias", name: "Rivalco", alias: "Rivalco Inc." }))).toBe(true);
    expect(applyChange(d, change({ type: "add_name", name: "rivalco", kind: "product" })).decided).toBe(d);
  });

  it("stops at a full list", () => {
    const d = BrandMapDecidedSchema.parse({ identity: { isNot: Array.from({ length: 8 }, (_, i) => `Thing ${i}`) } });
    expect(applyChange(d, change({ type: "add_is_not", text: "One more" })).issue).toBe("What you are not is full");
  });

  it("says each change in plain words", () => {
    expect(describeChange(change({ type: "add_name", name: "Rivalco", kind: "alternative" }))).toBe("Add Rivalco as an alternative");
    expect(describeChange(change({ type: "add_avoid", term: "LLM SEO", useInstead: "AI visibility tracking" }))).toBe(
      "Avoid “LLM SEO”. Say “AI visibility tracking”.",
    );
    expect(describeChange(change({ type: "add_question", subject: "Citation gaps", text: "Why does ChatGPT cite them?" }))).toBe(
      "Add a question to Citation gaps: “Why does ChatGPT cite them?”",
    );
    expect(describeChange(change({ type: "add_profile", url: "https://www.linkedin.com/company/acme-example/" }))).toBe(
      "Add a profile link: linkedin.com/company/acme-example",
    );
  });
});
