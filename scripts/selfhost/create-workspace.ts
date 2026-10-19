/**
 * Create the first workspace (brand) in your own Google Cloud project's Firestore, using
 * the app's own tenant code. `npm run selfhost` runs it for you; by hand:
 *
 *   npx tsx scripts/selfhost/create-workspace.ts --project <id> --list
 *   npx tsx scripts/selfhost/create-workspace.ts --project <id> --name "Acme" --domain acme.com [--region us]
 *
 *   --list            print the workspaces that exist, change nothing
 *   --name, --domain  the brand's name and its website's domain
 *   --region          us (default), eu or asia: where its data lives. Fixed once created;
 *                     eu and asia need their databases (npm run selfhost -- --apply addon:regions)
 *   --another         create one even though a workspace exists already
 *   --json            machine-readable output
 *
 * Signs in with Application Default Credentials (gcloud auth application-default login).
 * Refuses demo-* projects (those exist only in the emulators: use npm run local) and any
 * run with FIRESTORE_EMULATOR_HOST set.
 */

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const asJson = args.json === true;

function finish(result: Record<string, unknown>, code = 0): never {
  if (asJson) console.log(JSON.stringify(result));
  else if (result.message) console.log(String(result.message));
  process.exit(code);
}

function refuse(message: string): never {
  finish({ ok: false, error: message, message }, 1);
}

async function main() {
  const project = typeof args.project === "string" ? args.project : "";
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) refuse("Pass --project <your Google Cloud project id>.");
  if (project.startsWith("demo-")) refuse(`${project} is an emulator-only project. For a local run use npm run local.`);
  if (process.env.FIRESTORE_EMULATOR_HOST) refuse("FIRESTORE_EMULATOR_HOST is set, so this would write to the emulator. Unset it to create a workspace in your project.");

  // The tenant code reads the project from the environment when it first connects.
  process.env.GOOGLE_CLOUD_PROJECT = project;
  const { createTenant, listAllTenants, REGION_CONFIGS, TenantIsolationError } = await import("@/lib/tenant");
  const { normalizeDomain, slugifyTenantId } = await import("@/lib/tenant/tenantId");

  const existing = await listAllTenants();
  const summary = existing.map((t) => ({ id: t.id, name: t.tenantName, region: t.region }));
  if (args.list === true) {
    finish({ ok: true, tenants: summary, message: summary.length ? summary.map((t) => `${t.id}  ${t.name}  (${t.region})`).join("\n") : "No workspaces yet." });
  }

  if (existing.length && args.another !== true) {
    refuse(`A workspace already exists (${summary.map((t) => t.id).join(", ")}). Pass --another to create one more.`);
  }

  const name = typeof args.name === "string" ? args.name.trim() : "";
  const domain = typeof args.domain === "string" ? normalizeDomain(args.domain) : "";
  const region = typeof args.region === "string" ? args.region : "us";
  const id = slugifyTenantId(name);
  if (!name || name.length > 120 || !id) refuse('Pass --name "<brand name>" with letters or numbers in it.');
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) refuse("Pass --domain <your website's domain>, e.g. acme.com.");
  if (!(region in REGION_CONFIGS)) refuse("--region must be us, eu or asia.");

  const now = new Date().toISOString();
  try {
    await createTenant({
      id,
      tenantName: name,
      rootDomain: domain,
      status: "active",
      region: region as "us" | "eu" | "asia",
      // As in the app's own "new brand" flow: no origin is trusted until its domain is verified.
      allowedOrigins: [],
      billingTier: "mvp_free",
      ownerId: "selfhost",
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err instanceof TenantIsolationError) refuse(`The workspace id ${id} is taken. Pick another name.`);
    throw err;
  }
  finish({ ok: true, created: true, id, name, region, message: `Created workspace ${id} (${name}, ${region}).` });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const hint = /Could not load the default credentials|invalid_grant|reauth/i.test(message)
    ? " Run: gcloud auth application-default login"
    : /NOT_FOUND|does not exist/i.test(message)
      ? " Is the Firestore database created? (npm run selfhost -- --apply firestore)"
      : "";
  refuse(`${message.split("\n")[0]}${hint}`);
});
