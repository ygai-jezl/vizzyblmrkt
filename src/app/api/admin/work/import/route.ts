import { badInput, jsonBody, respond, respondChanged, TOO_BIG, workAdmin } from "@/lib/work/http";
import { IMPORT_MAX_BYTES, ImportBodySchema } from "@/lib/work/inputs";
import { refuse } from "@/lib/work/result";
import { importTasks, previewImport } from "@/lib/work/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Import a Backlog tab (WORK_ENABLED; admins and owners): a CSV file's text or rows pasted from
 * Google Sheets, up to 1,000 rows. `mode: "preview"` answers what each column fills, the first 20
 * rows and what would be refused, writing nothing; `mode: "import"` adds the tasks, each with the
 * import as its origin. The body is read up to a cap, never whole.
 */
export async function POST(req: Request) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  if (!gate.scope.canImport) return respond(refuse("forbidden_import"));
  const body = await jsonBody(req, IMPORT_MAX_BYTES + 64_000);
  if (body === TOO_BIG) return respond(refuse("import_too_big"));
  const parsed = ImportBodySchema.safeParse(body);
  if (!parsed.success) return badInput(parsed.error);
  if (parsed.data.mode === "preview") return respond(await previewImport(gate.scope, parsed.data));
  return respondChanged(gate.scope, await importTasks(gate.scope, parsed.data));
}
