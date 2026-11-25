/**
 * backfill-organisations.ts: give every brand that has no organisation one of its own,
 * org_<tenantId>, on the plan you name (PLANS_ENABLED; src/lib/tenant/organisations.ts). Run it
 * before turning plans on, and again straight after, to catch brands made in between.
 *
 * DRY RUN by default: it prints counts, plus the id of each brand whose access would narrow (a
 * lost feature, with the data it hides, or a lower cap) or widen (a gained feature or a higher
 * cap, so spend can rise). Pass --apply --by <label> to write. A change in either direction also
 * needs --allow-narrower or --allow-wider. Safe to re-run: a brand with an organisation is skipped.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-organisations.ts --plan ultra
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-organisations.ts --plan ultra --apply --by <label>
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-organisations.ts --check
 * Optional:  --tenant <tenantId>   --allow-narrower   --allow-wider   --local (the emulators only)
 *
 * --check is read only and exits 1 on drift: brands with no organisation, links that don't agree
 * both ways, plan copies that differ from their organisation's plan, organisations listing
 * missing brands, and org_<tenantId> ids taken by other brands. It warns about combined
 * organisations with no owners.
 *
 * --replan <plan> [--from-plan <plan>] fixes a backfill that used the wrong plan: it moves the
 * organisations the backfill set up (only those on --from-plan, when given) to <plan>, with the
 * same dry run, flags and --apply --by <label>. One that move-brand or the app took up again since
 * is theirs, and left alone. Never edit plans by hand.
 *
 * Export the deployment's own GRANTED_ONLY_FEATURES and FEATURE_MONTHLY_LIMITS first: the dry run
 * reads them from this shell, and prints what it read.
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`). --by takes a
 * short label (lower case letters, digits, _ and -), recorded as backfill:<label>, never an email.
 */

import type { AccessChanges } from "@/lib/plans/preview";
import type { PlanId } from "@/lib/types/organisation";
import { count, parseOperatorArgs, printHeader, refuse, settleEnvironment } from "./lib/operatorCli";

const TOOL = "backfill-organisations";
const args = parseOperatorArgs(
  TOOL,
  process.argv.slice(2),
  ["plan", "tenant", "by", "replan", "from-plan"],
  ["apply", "check", "local", "allow-narrower", "allow-wider"],
);
const APPLY = args.has("apply");
const ONLY_TENANT = args.get("tenant");
const ALLOW = { narrower: args.has("allow-narrower"), wider: args.has("allow-wider") };

function say(line: string): void {
  console.log(`[${TOOL}] ${line}`);
}

async function main() {
  if (args.has("check") && (APPLY || args.get("plan") || args.get("replan"))) refuse(TOOL, "--check is read only: pass it on its own.");
  if (args.get("plan") && args.get("replan")) refuse(TOOL, "Pass --plan to backfill, or --replan to change what a backfill did, not both.");
  if (args.get("from-plan") && !args.get("replan")) refuse(TOOL, "--from-plan goes with --replan.");

  const where = settleEnvironment(TOOL, args.has("local"));
  // Imported after the environment is settled, so the library reads it.
  const tenantLib = await import("@/lib/tenant");
  const { TenantValidationError } = await import("@/lib/tenant/errors");
  const { accessChangeLines, accessChanges, guardChanges, previewSettingsLines } = await import("@/lib/plans/preview");
  const { PLAN_IDS, PlanIdSchema } = await import("@/lib/types/organisation");
  const { planById } = await import("@/lib/plans/catalog");

  printHeader(TOOL, where, previewSettingsLines());

  const planArg = (flag: string) => {
    const raw = args.get(flag);
    const parsed = PlanIdSchema.safeParse(raw);
    if (!parsed.success) refuse(TOOL, `--${flag} takes one of: ${PLAN_IDS.join(", ")}.`);
    return parsed.data;
  };
  const planName = (id: PlanId) => planById(id)?.name ?? id;
  const actorOrRefuse = (): string => {
    try {
      return tenantLib.scriptActor("backfill", args.get("by"));
    } catch (err) {
      if (err instanceof TenantValidationError) refuse(TOOL, `${err.message}. --apply needs --by <label>.`);
      throw err;
    }
  };
  // A label given on a dry run is checked too, so the real run doesn't fail on it.
  const actor = APPLY || args.get("by") ? actorOrRefuse() : null;

  if (args.has("check")) {
    const [brands, organisations] = await Promise.all([tenantLib.listAllTenants(), tenantLib.listOrganisations()]);
    const d = tenantLib.organisationDrift(brands, organisations);
    say(`${count(brands.length, "brand")}, ${count(organisations.length, "organisation")}.`);
    const section = (title: string, rows: string[], hint: string) => {
      if (!rows.length) return;
      say(`${title}: ${rows.length}. ${hint}`);
      for (const row of rows) console.log(`  ${row}`);
    };
    section("Brands with no organisation (open, no plan)", d.open, "Run this script with --plan <plan>.");
    section("org_<id> taken by other brands", d.conflicts.map((c) => `${c.tenantId}: ${c.organisationId} lists other brands`), "Give the brand its own with scripts/move-brand.ts --tenant <tenantId> --to new --plan <plan>.");
    section("Brands pointing at a missing organisation", d.missingOrganisation.map((r) => `${r.tenantId} -> ${r.organisationId}`), "Use scripts/move-brand.ts --tenant <tenantId> --to new --plan <plan>.");
    section("Brands their organisation doesn't list", d.notListed.map((r) => `${r.tenantId} -> ${r.organisationId}`), "Use scripts/move-brand.ts --tenant <tenantId> --to <orgId>.");
    section("Plan copies that differ from the organisation's plan", d.planDrift.map((r) => `${r.tenantId}: copy ${r.orgPlan ?? "(none)"}, ${r.organisationId} is on ${r.plan}`), "Setting the same plan again repairs them: scripts/set-plan.ts --organisation <orgId> --plan <its plan>.");
    section("Organisations listing a missing brand", d.missingBrands.map((r) => `${r.organisationId} lists ${r.tenantId}`), "Look at these by hand before changing anything.");
    section("Organisations listing a brand that points elsewhere", d.listedElsewhere.map((r) => `${r.organisationId} lists ${r.tenantId}, which points at ${r.linkedTo ?? "no organisation"}`), "Look at these by hand before changing anything.");
    if (d.ownerless.length) {
      say(`Warning: ${count(d.ownerless.length, "organisation")} ${d.ownerless.length === 1 ? "holds" : "hold"} more than one brand and no owners, so nobody sees their totals. Add one with scripts/set-plan.ts --organisation <orgId> --add-owner <uid>.`);
      for (const id of d.ownerless) console.log(`  ${id}`);
    }
    if (tenantLib.hasDrift(d)) {
      say("Drift found.");
      process.exit(1);
    }
    say("Clean: every brand and organisation agree.");
    return;
  }

  if (args.get("replan")) {
    const next = planArg("replan");
    const fromPlan = args.get("from-plan") ? planArg("from-plan") : null;
    const [brands, organisations] = await Promise.all([tenantLib.listAllTenants(), tenantLib.listOrganisations()]);
    const byId = new Map(brands.map((b) => [b.id, b]));
    const targets = organisations.filter(
      (o) => o.createdBy === "backfill" && (!fromPlan || o.plan === fromPlan) && (!ONLY_TENANT || o.brandIds.includes(ONLY_TENANT)),
    );
    const moving = targets.filter((o) => o.plan !== next);
    say(`${count(targets.length, "organisation")} the backfill created${fromPlan ? ` on ${planName(fromPlan)}` : ""}: ${moving.length} would move to ${planName(next)}, ${targets.length - moving.length} on it already.`);
    if (!moving.length) {
      say("nothing to change");
      return;
    }
    const all: AccessChanges[] = [];
    for (const org of moving) {
      for (const id of org.brandIds) {
        const brand = byId.get(id);
        if (!brand) {
          console.log(`  ${org.id}: lists ${id}, which is missing (skipped)`);
          continue;
        }
        const changes = accessChanges(brand, next);
        all.push(changes);
        const lines = accessChangeLines(changes);
        if (lines.length) console.log(`  ${id} (${org.id}, ${planName(org.plan)} to ${planName(next)}):\n${lines.map((l) => `    ${l}`).join("\n")}`);
      }
    }
    say(`Narrower: ${count(all.filter((c) => c.narrower).length, "brand")}. Wider: ${count(all.filter((c) => c.wider).length, "brand")}.`);
    const blocked = guardChanges(all, ALLOW);
    if (!APPLY) {
      if (blocked) say(`--apply would be refused: ${blocked}`);
      say("dry run: pass --apply --by <label> to write");
      return;
    }
    if (blocked) refuse(TOOL, blocked);
    let failed = 0;
    for (const org of moving) {
      try {
        const res = await tenantLib.setOrganisationPlan(org.id, next, actor!);
        if (!res) {
          failed += 1;
          console.log(`  ${org.id}: missing now (skipped)`);
          continue;
        }
        const notes = [
          ...(res.missingBrands.length ? [`missing brands skipped: ${res.missingBrands.join(", ")}`] : []),
          ...(res.unlinkedBrands.length ? [`brands pointing elsewhere skipped: ${res.unlinkedBrands.join(", ")}`] : []),
        ];
        console.log(`  ${org.id}: now on ${planName(next)}${notes.length ? ` (${notes.join("; ")})` : ""}`);
      } catch (err) {
        failed += 1;
        console.log(`  ${org.id}: failed (${err instanceof Error ? err.message : "unknown error"})`);
      }
    }
    say(`done: ${moving.length - failed} replanned, ${failed} failed. Run --check next.`);
    if (failed) process.exit(1);
    return;
  }

  const plan = planArg("plan");
  const all = await tenantLib.listAllTenants();
  const brands = ONLY_TENANT ? all.filter((b) => b.id === ONLY_TENANT) : all;
  if (ONLY_TENANT && !brands.length) refuse(TOOL, `No brand "${ONLY_TENANT}" in ${where.project}.`);
  const open = brands.filter((b) => !b.organisationId);
  say(`${count(brands.length, "brand")}: ${brands.length - open.length} with an organisation already, ${open.length} with none.`);
  if (!open.length) {
    say("nothing to change");
    return;
  }

  type Row = { id: string; action: "create" | "reuse" | "relink" | "conflict"; orgId: string; plan: PlanId };
  const rows: Row[] = [];
  const previews: AccessChanges[] = [];
  for (const brand of open) {
    const orgId = tenantLib.organisationIdFor(brand.id);
    const existing = await tenantLib.getOrganisation(orgId);
    // As ensureBrandOrganisation decides, on the raw record: an empty org_<id> is reused even when it
    // doesn't parse (so its connections are cleared first), and one that lists the brand relinks on its own plan.
    const reusable = await tenantLib.reusableOrganisationId(brand.id);
    const row: Row = reusable
      ? { id: brand.id, action: "reuse", orgId, plan }
      : !existing
      ? { id: brand.id, action: "create", orgId, plan }
      : existing.brandIds.includes(brand.id)
        ? { id: brand.id, action: "relink", orgId, plan: existing.plan }
        : existing.brandIds.length
          ? { id: brand.id, action: "conflict", orgId, plan }
          : { id: brand.id, action: "reuse", orgId, plan };
    rows.push(row);
    if (row.action === "conflict") continue;
    const changes = accessChanges(brand, row.plan);
    previews.push(changes);
    const lines = accessChangeLines(changes);
    const note = row.action === "relink" ? ` (relinks to ${orgId}, which lists it already, on ${planName(row.plan)})` : "";
    if (lines.length || note) console.log(`  ${brand.id}${note}${lines.length ? `:\n${lines.map((l) => `    ${l}`).join("\n")}` : ""}`);
  }
  const tally = (a: Row["action"]) => rows.filter((r) => r.action === a).length;
  say(`On ${planName(plan)}: ${count(tally("create"), "new organisation")}, ${count(tally("reuse"), "empty one")} reused, ${tally("relink")} relinked, ${count(tally("conflict"), "conflict")}.`);
  say(`Narrower: ${count(previews.filter((c) => c.narrower).length, "brand")}. Wider: ${count(previews.filter((c) => c.wider).length, "brand")}.`);
  const conflicts = rows.filter((r) => r.action === "conflict");
  if (conflicts.length) {
    say(`Conflicts stay open (no organisation): their org_<id> lists other brands. Give each its own with scripts/move-brand.ts --tenant <tenantId> --to new --plan <plan>.`);
    for (const r of conflicts) console.log(`  ${r.id}: ${r.orgId} lists other brands`);
  }
  const blocked = guardChanges(previews, ALLOW);
  if (!APPLY) {
    if (blocked) say(`--apply would be refused: ${blocked}`);
    say("dry run: pass --apply --by <label> to write");
    return;
  }
  if (blocked) refuse(TOOL, blocked);

  const results: Record<string, string[]> = { created: [], exists: [], conflict: [], missing_brand: [], failed: [] };
  const { clearOrganisationIdForReuse } = await import("@/lib/connectors/organisation");
  for (const brand of open) {
    try {
      // An empty org_<id> taken up again never carries a sign in (Connectors 3): its connections go
      // first. Read raw again now, so one emptied since the dry run is cleared too.
      const reused = await tenantLib.reusableOrganisationId(brand.id);
      if (reused) {
        const cleared = await clearOrganisationIdForReuse(reused, actor!);
        if (cleared) console.log(`  ${brand.id}: ${count(cleared, "connection")} left on ${tenantLib.organisationIdFor(brand.id)} disconnected first`);
      }
      const res = await tenantLib.ensureBrandOrganisation(brand.id, { plan, createdBy: "backfill", actor: actor! });
      results[res.status]!.push(brand.id);
    } catch (err) {
      results.failed!.push(brand.id);
      console.log(`  ${brand.id}: failed (${err instanceof Error ? err.message : "unknown error"})`);
    }
  }
  say(`done: ${results.created!.length} given an organisation, ${results.exists!.length} had one, ${results.conflict!.length} conflicts, ${results.missing_brand!.length} missing, ${results.failed!.length} failed.`);
  for (const id of results.conflict!) console.log(`  conflict: ${id} (${tenantLib.organisationIdFor(id)} lists other brands)`);
  for (const id of results.missing_brand!) console.log(`  missing: ${id}`);
  say("Run --check next.");
  if (results.failed!.length) process.exit(1);
}

main().catch((err) => {
  console.error(`[${TOOL}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
