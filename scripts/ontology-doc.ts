import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { callSites } from "@/lib/loops/callSites";
import { renderOntologyDoc } from "@/lib/ontology/doc";

/**
 * Write docs/ONTOLOGY.md from the ontology registry (src/lib/ontology/registry.ts) and the
 * learning registry (src/lib/loops/registry.ts):
 *
 *   npm run ontology:doc
 *
 * Run it after changing either registry, or after adding, moving or renaming a file that makes a
 * kind (a meter call, a canvas, a rule), and commit the file with the change. It reads the source
 * under src for the Learning section's call sites (src/lib/loops/callSites.ts) and touches no
 * database. src/lib/ontology/doc.test.ts fails while the file is out of date.
 */
const target = join(process.cwd(), "docs", "ONTOLOGY.md");
writeFileSync(target, renderOntologyDoc(callSites()));
process.stdout.write("ontology:doc: wrote docs/ONTOLOGY.md from src/lib/ontology/registry.ts and src/lib/loops/registry.ts\n");
