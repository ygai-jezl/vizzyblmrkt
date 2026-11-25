/**
 * move-brand.ts: move one brand to another organisation (combine brands, when an owner asks), or
 * split it back out into an organisation of its own (PLANS_ENABLED; src/lib/tenant/organisations.ts).
 * Brands are only ever combined on purpose, with this script.
 *
 *   --to <orgId>             the brand joins that organisation and takes its plan. Refused while
 *                            the organisation is at its plan's brands allowance: change its plan
 *                            first with scripts/set-plan.ts.
 *   --to new --plan <plan>   the brand gets an organisation of its own on <plan>: org_<tenantId>,
 *                            or org_<tenantId>_<6 characters> when that id is taken.
 * The organisation the brand leaves is kept, even when it is left empty.
 *
 * DRY RUN by default: it shows the organisations the brand leaves and joins, the features it would
 * lose (with the data each hides) or gain, and the caps lowered or raised. Pass --apply --by
 * <label> to write. A change in either direction also needs --allow-narrower or --allow-wider.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/move-brand.ts --tenant <tenantId> --to <orgId>
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/move-brand.ts --tenant <tenantId> --to <orgId> --apply --by <label>
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/move-brand.ts --tenant <tenantId> --to new --plan ultra
 * Optional:  --allow-narrower   --allow-wider   --local (the emulators only)
 *
 * After combining, add the people who should see the combined totals with scripts/set-plan.ts
 * --organisation <orgId> --add-owner <uid>.
 *
 * Shared connections (Connectors 3, ADR-0015), whatever any switch says: after a move, the brand's
 * parts from the organisation it left end, and what was collected through them is erased; when the
 * move leaves that organisation with no brands, every connection it holds is disconnected, in every
 * region. An empty org_<tenantId> taken up again (--to new) has its connections disconnected first,
 * so it never carries a sign in. The dry run says how many would be.
 *
 * Export the deployment's own GRANTED_ONLY_FEATURES and FEATURE_MONTHLY_LIMITS first: the dry run
 * reads them from this shell, and prints what it read.
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`). --by takes a
 * short label (lower case letters, digits, _ and -), recorded as script:<label>, never an email.
 */

import { count, parseOperatorArgs, printHeader, refuse, settleEnvironment } from "./lib/operatorCli";

const TOOL = "move-brand";
const args = parseOperatorArgs(TOOL, process.argv.slice(2), ["tenant", "to", "plan", "by"], ["apply", "local", "allow-narrower", "allow-wider"]);
const APPLY = args.has("apply");
const ALLOW = { narrower: args.has("allow-narrower"), wider: args.has("allow-wider") };

function say(line: string): void {
  console.log(`[${TOOL}] ${line}`);
}

async function main() {
  const tenantId = args.get("tenant");
  const to = args.get("to");
  if (!tenantId || !to) refuse(TOOL, "Pass --tenant <tenantId>, and --to <orgId> or --to new --plan <plan>.");
  if (to === "new" && !args.get("plan")) refuse(TOOL, "--to new needs --plan <plan>.");
  if (to !== "new" && args.get("plan")) refuse(TOOL, "A brand takes the plan of the organisation it joins. --plan goes with --to new only; change a plan with scripts/set-plan.ts.");

  const where = settleEnvironment(TOOL, args.has("local"));
  // Imported after the environment is settled, so the library reads it.
  const tenantLib = await import("@/lib/tenant");
  const { TenantValidationError } = await import("@/lib/tenant/errors");
  const { accessChangeLines, accessChanges, guardChanges, previewSettingsLines } = await import("@/lib/plans/preview");
  const { allowanceLimit, planById } = await import("@/lib/plans/catalog");
  const { PLAN_IDS, PlanIdSchema } = await import("@/lib/types/organisation");
  const orgConnections = await import("@/lib/connectors/organisation");

  printHeader(TOOL, where, previewSettingsLines());

  const actorOrRefuse = (): string => {
    try {
      return tenantLib.scriptActor("script", args.get("by"));
    } catch (err) {
      if (err instanceof TenantValidationError) refuse(TOOL, `${err.message}. --apply needs --by <label>.`);
      throw err;
    }
  };
  const actor = APPLY || args.get("by") ? actorOrRefuse() : null;

  const brand = await tenantLib.getTenantById(tenantId);
  if (!brand) refuse(TOOL, `No brand "${tenantId}" in ${where.project}.`);
  const from = brand.organisationId ? await tenantLib.getOrganisation(brand.organisationId) : null;
  const orgText = (o: { id: string; name: string; plan: string; brandIds: string[] }) =>
    `${o.id} "${o.name}" (${planById(o.plan)?.name ?? o.plan}, ${count(o.brandIds.length, "brand")})`;
  say(`Brand ${tenantId} "${brand.tenantName}" is in ${from ? orgText(from) : brand.organisationId ? `${brand.organisationId}, which is missing or doesn't read` : "no organisation (open, no plan)"}.`);

  // What the move ends: the brand's parts from the organisation it leaves, and that organisation's
  // connections when it is left with no brands.
  const brandRef = { tenantId: brand.id, region: brand.region };
  const leaving = async () => {
    if (!from) return;
    const parts = (await tenantLib.forTenant({ ...brandRef, source: "system" }).dataConnections.find({ where: [["status", "==", "connected"]], limit: 200 })).filter((c) => c.source?.organisationId === from.id).length;
    const left = from.brandIds.filter((id) => id !== tenantId).length;
    const held = left ? 0 : (await tenantLib.listOrganisationConnections(from.id)).filter((c) => c.status === "connected").length;
    say(`Its ${count(parts, "part")} from ${from.id} would end, and what was collected through them be erased.${left ? "" : ` ${from.id} would have no brands left, so its ${count(held, "connection")} would be disconnected in every region.`}`);
  };
  const afterMove = async () => {
    if (!from) return;
    const ended = await orgConnections.endBrandParts(brandRef, { fromOrganisationId: from.id, by: actor! });
    const off = await orgConnections.disconnectEmptiedOrganisation(from.id, actor!);
    say(`${count(ended, "part")} from ${from.id} ended${off ? `; ${count(off, "connection")} of ${from.id}, left with no brands, disconnected` : ""}.`);
  };

  const showChanges = (nextPlan: Parameters<typeof accessChanges>[1]) => {
    const changes = accessChanges(brand, nextPlan);
    const lines = accessChangeLines(changes);
    console.log(lines.length ? lines.map((l) => `  ${l}`).join("\n") : "  No change to what the brand may use or its caps.");
    return changes;
  };

  if (to === "new") {
    const plan = PlanIdSchema.safeParse(args.get("plan")).data ?? refuse(TOOL, `--plan takes one of: ${PLAN_IDS.join(", ")}.`);
    if (from && from.brandIds.length === 1 && from.brandIds[0] === tenantId) {
      say(`It is on its own in ${from.id} already. Change its plan with scripts/set-plan.ts --organisation ${from.id} --plan ${plan}.`);
      say("nothing to change");
      return;
    }
    // Read raw, as the move decides: an empty org_<id> that doesn't parse is taken up (and cleared) too.
    const reusedId = await tenantLib.reusableOrganisationId(tenantId);
    const own = await tenantLib.getOrganisation(tenantLib.organisationIdFor(tenantId));
    const targetId = reusedId || !own ? tenantLib.organisationIdFor(tenantId) : `${tenantLib.organisationIdFor(tenantId)}_<6 characters>`;
    say(`Would move it to a new organisation of its own, ${targetId}, on ${planById(plan)!.name}.`);
    const changes = showChanges(plan);
    if (from) say(`${from.id} is kept, with ${count(from.brandIds.filter((id) => id !== tenantId).length, "brand")}.`);
    await leaving();
    const carried = reusedId ? (await tenantLib.listOrganisationConnections(reusedId)).filter((c) => c.status === "connected").length : 0;
    if (carried) say(`${reusedId} still holds ${count(carried, "connection")}: they would be disconnected first, so the brand never takes up a sign in.`);
    const blocked = guardChanges([changes], ALLOW);
    if (!APPLY) {
      if (blocked) say(`--apply would be refused: ${blocked}`);
      say("dry run: pass --apply --by <label> to write");
      return;
    }
    if (blocked) refuse(TOOL, blocked);
    if (reusedId) await orgConnections.clearOrganisationIdForReuse(reusedId, actor!);
    // takeUp: only the id just cleared may be taken up again; any other existing one is passed over.
    const res = await tenantLib.moveBrandToNewOrganisation(tenantId, { plan, actor: actor!, takeUp: reusedId });
    if (!res) refuse(TOOL, `${tenantId} went missing.`);
    say(res.moved ? `done: ${tenantId} is in ${res.organisationId} on ${planById(plan)!.name}.` : `${tenantId} is on its own in ${res.organisationId} already; nothing changed.`);
    if (res.moved) await afterMove();
    return;
  }

  const target = await tenantLib.getOrganisation(to);
  if (!target) refuse(TOOL, `Organisation "${to}" is missing or doesn't read.`);
  if (brand.organisationId === target.id && target.brandIds.includes(tenantId)) {
    say(`It is in ${target.id} already.`);
    say("nothing to change");
    return;
  }
  const targetPlan = planById(target.plan)!;
  const maxBrands = allowanceLimit(targetPlan, "brands");
  const others = target.brandIds.filter((id) => id !== tenantId).length;
  const full = maxBrands !== null && others >= maxBrands;
  say(`Would move it to ${orgText(target)}, ${maxBrands === null ? "with no brands limit" : `${others} of ${maxBrands} brands before the move`}.`);
  const changes = showChanges(target.plan);
  say(`${count(target.ownerIds.length, "owner")} of ${target.id} would see this brand's figures on Plan and usage.`);
  if (from) say(`${from.id} is kept, with ${count(from.brandIds.filter((id) => id !== tenantId).length, "brand")}.`);
  if (from && from.id !== target.id) await leaving();
  if (full) say(`${target.id} is at its brands allowance on ${targetPlan.name}. Change its plan first with scripts/set-plan.ts --organisation ${target.id} --plan <plan>.`);
  const blocked = guardChanges([changes], ALLOW);
  if (!APPLY) {
    if (full) say("--apply would be refused while it is full.");
    if (blocked) say(`--apply would be refused: ${blocked}`);
    say("dry run: pass --apply --by <label> to write");
    return;
  }
  if (full) refuse(TOOL, `${target.id} is at its brands allowance.`);
  if (blocked) refuse(TOOL, blocked);
  const res = await tenantLib.attachBrandToOrganisation(tenantId, target.id, { actor: actor!, maxBrands });
  if (res === "full") refuse(TOOL, `${target.id} filled up meanwhile: nothing changed.`);
  if (res === "missing") refuse(TOOL, "The brand or the organisation went missing: nothing changed.");
  say(res === "already" ? `${tenantId} is in ${target.id} already; nothing changed.` : `done: ${tenantId} is in ${target.id} on ${targetPlan.name}.`);
  if (res === "moved" && from && from.id !== target.id) await afterMove();
}

main().catch((err) => {
  console.error(`[${TOOL}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
