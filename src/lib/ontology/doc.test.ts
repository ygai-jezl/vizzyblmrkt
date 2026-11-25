import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { callSites, type CallSites } from "@/lib/loops/callSites";
import { LOOPS, type LoopKind } from "@/lib/loops/registry";
import { renderOntologyDoc } from "./doc";
import { ONTOLOGY } from "./registry";

describe("docs/ONTOLOGY.md", () => {
  const sites = callSites();
  const rendered = renderOntologyDoc(sites);

  it("matches both registries and the code's call sites (run npm run ontology:doc after changing them)", () => {
    const onDisk = readFileSync(join(process.cwd(), "docs", "ONTOLOGY.md"), "utf8");
    expect(onDisk === rendered, "docs/ONTOLOGY.md is out of date: run npm run ontology:doc and commit it").toBe(true);
  });

  it("goes stale when a call site file is added, moved or removed", () => {
    // The check above compares the whole render, so a changed Learning section fails it too.
    const kind: LoopKind = "content_write";
    expect(sites[kind].length).toBeGreaterThan(0);
    const moved: CallSites = { ...sites, [kind]: [...sites[kind].slice(1), "src/lib/content/create/elsewhere.ts"] };
    expect(renderOntologyDoc(moved)).not.toBe(rendered);
  });

  it("says it is generated, and has every type and every learning kind", () => {
    expect(rendered.split("\n")[2]).toContain("npm run ontology:doc");
    for (const t of ONTOLOGY) expect(rendered, t.id).toContain(`(\`${t.id}\`)`);
    const learning = rendered.slice(rendered.indexOf("\n## Learning\n"));
    expect(learning.length).toBeGreaterThan(0);
    for (const kind of Object.keys(LOOPS)) expect(learning, kind).toContain(`\n- \`${kind}\` (`);
  });

  it("names on each type the choices its stores hold", () => {
    for (const t of ONTOLOGY) {
      if (!t.madeBy.length) continue;
      expect(rendered, t.id).toContain(`- Made by: ${t.madeBy.map((k) => `\`${k}\``).join(", ")} (see Learning)`);
    }
  });

  it("is the same every time", () => {
    expect(renderOntologyDoc(callSites())).toBe(rendered);
  });

  it("is in house style: no dashes as punctuation and no AI tells", () => {
    expect(dashesIn(rendered)).toEqual([]);
    expect(aiTellsIn(rendered)).toEqual([]);
  });
});
