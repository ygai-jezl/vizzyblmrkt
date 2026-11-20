import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { renderOntologyDoc } from "./doc";
import { ONTOLOGY } from "./registry";

describe("docs/ONTOLOGY.md", () => {
  const rendered = renderOntologyDoc();

  it("matches the registry (run npm run ontology:doc after changing it)", () => {
    const onDisk = readFileSync(join(process.cwd(), "docs", "ONTOLOGY.md"), "utf8");
    expect(onDisk === rendered, "docs/ONTOLOGY.md is out of date: run npm run ontology:doc and commit it").toBe(true);
  });

  it("says it is generated, and has every type", () => {
    expect(rendered.split("\n")[2]).toContain("npm run ontology:doc");
    for (const t of ONTOLOGY) expect(rendered, t.id).toContain(`(\`${t.id}\`)`);
  });

  it("is the same every time", () => {
    expect(renderOntologyDoc()).toBe(rendered);
  });

  it("is in house style: no dashes as punctuation and no AI tells", () => {
    expect(dashesIn(rendered)).toEqual([]);
    expect(aiTellsIn(rendered)).toEqual([]);
  });
});
