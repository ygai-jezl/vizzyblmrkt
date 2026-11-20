import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderOntologyDoc } from "@/lib/ontology/doc";

/**
 * Write docs/ONTOLOGY.md from the ontology registry (src/lib/ontology/registry.ts):
 *
 *   npm run ontology:doc
 *
 * Run it after changing the registry and commit the file with the change. Reads nothing but the
 * registry and touches no database. src/lib/ontology/doc.test.ts fails while the file is out of date.
 */
const target = join(process.cwd(), "docs", "ONTOLOGY.md");
writeFileSync(target, renderOntologyDoc());
process.stdout.write("ontology:doc: wrote docs/ONTOLOGY.md from src/lib/ontology/registry.ts\n");
