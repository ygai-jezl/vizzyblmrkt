/**
 * set-plan.ts: show an organisation's plan and use, and change its plan, its name or the owners
 * who see its totals on Plan and usage (PLANS_ENABLED; src/lib/tenant/organisations.ts).
 *
 * With no change flags it shows the plan, since when, the brands, how many owners and users, and
 * the allowances with what is used. A plan change copies the plan onto every brand in the
 * organisation in one transaction.
 *
 * DRY RUN by default: for a plan change it lists, per brand, the features lost (with the data each
 * hides) or gained and the caps lowered or raised, and warns about allowances already over the new
 * plan. Nobody and nothing is removed; new ones wait for room. Pass --apply --by <label> to write.
 * A change in either direction also needs --allow-narrower or --allow-wider.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/set-plan.ts --tenant <tenantId>
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/set-plan.ts --organisation <orgId> --plan pro
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/set-plan.ts --organisation <orgId> --plan pro --apply --by <label> --allow-narrower
 * Change flags:  --plan <plan>   --name "<name>"   --add-owner <uid>   --remove-owner <uid>
 *   (owner flags may repeat, or take ids separated by commas)
 * Optional:  --allow-narrower   --allow-wider   --local (the emulators only)
 *
 * Export the deployment's own GRANTED_ONLY_FEATURES and FEATURE_MONTHLY_LIMITS first: the dry run
 * reads them from this shell, and prints what it read.
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`). --by takes a
 * short label (lower case letters, digits, _ and -), recorded as script:<label>, never an email.
 */

import type { AccessChanges } from "@/lib/plans/preview";
import type { Tenant } from "@/lib/types/tenant";
import { count, parseOperatorArgs, printHeader, refuse, settleEnvironment } from "./lib/operatorCli";

const TOOL = "set-plan";
const args = parseOperatorArgs(
  TOOL,
  process.argv.slice(2),
  ["organisation", "tenant", "plan", "name", "add-owner", "remove-owner", "by"],
  ["apply", "local", "allow-narrower", "allow-wider"],
);
const APPLY = args.has("apply");
const ALLOW = { narrower: args.has("allow-narrower"), wider: args.has("allow-wider") };

function say(line: string): void {
  console.log(`[${TOOL}] ${line}`);
}

const n = (v: number) => v.toLocaleString("en-US");

async function main() {
  const orgArg = args.get("organisation");
  const tenantArg = args.get("tenant");
  if (Boolean(orgArg) === Boolean(tenantArg)) refuse(TOOL, "Pass --organisation <orgId> or --tenant <tenantId> (that brand's organisation).");

  const where = settleEnvironment(TOOL, args.has("local"));
  // Imported after the environment is settled, so the library reads it.
  const tenantLib = await import("@/lib/tenant");
  const { TenantValidationError } = await import("@/lib/tenant/errors");
  const { accessChangeLines, accessChanges, guardChanges, previewSettingsLines } = await import("@/lib/plans/preview");
  const { ALLOWANCES, ALLOWANCE_LABELS, COUNTED_ALLOWANCES, allowanceLimit, allowanceText, planById } = await import("@/lib/plans/catalog");
  const { organisationAllowance } = await import("@/lib/plans/usage");
  const { MAX_ORGANISATION_NAME, MAX_ORGANISATION_OWNERS, PLAN_IDS, PlanIdSchema } = await import("@/lib/types/organisation");

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

  // The changes asked for, checked before any read.
  const planRaw = args.get("plan");
  const nextPlanId = planRaw === undefined ? null : PlanIdSchema.safeParse(planRaw).data ?? refuse(TOOL, `--plan takes one of: ${PLAN_IDS.join(", ")}.`);
  const nameRaw = args.get("name");
  const nextName = nameRaw === undefined ? null : nameRaw.trim();
  if (nextName !== null && (!nextName || nextName.length > MAX_ORGANISATION_NAME)) refuse(TOOL, `--name takes 1 to ${MAX_ORGANISATION_NAME} characters.`);
  const addOwners = args.all("add-owner");
  const removeOwners = args.all("remove-owner");
  if ([...addOwners, ...removeOwners].some((id) => id.length > 128 || /\s/.test(id))) refuse(TOOL, "An owner is a Firebase user id (uid), with no spaces.");

  // The organisation.
  let orgId = orgArg ?? "";
  if (tenantArg) {
    const brand = await tenantLib.getTenantById(tenantArg);
    if (!brand) refuse(TOOL, `No brand "${tenantArg}" in ${where.project}.`);
    if (!brand.organisationId) refuse(TOOL, `${tenantArg} has no organisation yet. Give it one with scripts/backfill-organisations.ts --tenant ${tenantArg} --plan <plan>.`);
    orgId = brand.organisationId;
  }
  const org = await tenantLib.getOrganisation(orgId);
  if (!org) refuse(TOOL, `Organisation "${orgId}" is missing or doesn't read. scripts/backfill-organisations.ts --check reports why.`);
  const plan = planById(org.plan)!;

  const brands: Array<{ id: string; tenant: Tenant | null; live: number | null; capped: boolean }> = [];
  for (const id of org.brandIds) {
    const tenant = await tenantLib.getTenantById(id).catch(() => null);
    const live = tenant ? await tenantLib.countLiveLaunches({ tenantId: id, region: tenant.region }).catch(() => null) : null;
    brands.push({ id, tenant, live: live?.count ?? null, capped: live?.capped ?? false });
  }
  const users = (await tenantLib.organisationUserIds(org)).size;
  const people = (await organisationAllowance(org, "people")).used;

  say(`${org.id} "${org.name}": ${plan.name} (${plan.id}) since ${org.planSince.slice(0, 10)}, created by ${org.createdBy}`);
  console.log(`  Brands: ${org.brandIds.length}${allowanceLimit(plan, "brands") === null ? "" : ` of ${n(allowanceLimit(plan, "brands")!)}`}`);
  for (const b of brands) {
    const live = b.live === null ? "couldn't count" : `${n(b.live)}${b.capped ? " or more" : ""}`;
    console.log(b.tenant ? `    ${b.id}  ${b.tenant.tenantName}  ${b.tenant.region}  ${b.tenant.status}  live launches ${live}${b.tenant.orgPlan === org.plan ? "" : `  (plan copy ${b.tenant.orgPlan ?? "none"})`}` : `    ${b.id}  (missing)`);
  }
  console.log(`  Owners: ${org.ownerIds.length}`);
  for (const key of ALLOWANCES) {
    if (key === "brands") continue;
    const used = key === "users" ? users : key === "people" ? people : null;
    const counted = COUNTED_ALLOWANCES.includes(key) && key !== "liveIdeas";
    const usedText = key === "liveIdeas" ? "per brand, above" : counted ? (used === null ? "couldn't count" : `${n(used)} used`) : "not counted yet";
    console.log(`  ${ALLOWANCE_LABELS[key]}: ${allowanceText(plan, key)} (${usedText})`);
  }

  const wantsChange = nextPlanId !== null || nextName !== null || addOwners.length > 0 || removeOwners.length > 0;
  if (!wantsChange) return;

  // What would change.
  const previews: AccessChanges[] = [];
  let planChange = false;
  if (nextPlanId !== null) {
    const next = planById(nextPlanId)!;
    const copies = brands.filter((b) => b.tenant && b.tenant.orgPlan !== nextPlanId).length;
    planChange = org.plan !== nextPlanId || copies > 0;
    if (!planChange) {
      say(`Plan: ${org.id} is on ${next.name} already.`);
    } else {
      say(org.plan === nextPlanId ? `Plan: stays ${next.name}, and repairs the plan copy on ${count(copies, "brand")}.` : `Plan: ${plan.name} to ${next.name}.`);
      for (const b of brands) {
        if (!b.tenant) {
          console.log(`  ${b.id}: missing (skipped)`);
          continue;
        }
        const changes = accessChanges(b.tenant, nextPlanId);
        previews.push(changes);
        const lines = accessChangeLines(changes);
        console.log(lines.length ? `  ${b.id}:\n${lines.map((l) => `    ${l}`).join("\n")}` : `  ${b.id}: no change`);
      }
      const over: string[] = [];
      const check = (label: string, used: number | null, limit: number | null) => {
        if (used !== null && limit !== null && used > limit) over.push(`${label} ${n(used)} of ${n(limit)}`);
      };
      check("brands", org.brandIds.length, allowanceLimit(next, "brands"));
      check("users", users, allowanceLimit(next, "users", users));
      check("people", people, allowanceLimit(next, "people", users));
      for (const b of brands) check(`live launches in ${b.id}`, b.live, allowanceLimit(next, "liveIdeas"));
      if (over.length) say(`Already over ${next.name}: ${over.join(", ")}. Nobody and nothing is removed; new ones wait for room.`);
    }
  }
  const nameChange = nextName !== null && nextName !== org.name;
  if (nextName !== null) say(nameChange ? `Name: "${org.name}" to "${nextName}".` : `Name: "${org.name}" already.`);
  const owners = [...new Set([...org.ownerIds.filter((id) => !removeOwners.includes(id)), ...addOwners.filter((id) => !removeOwners.includes(id))])];
  const ownersChange = owners.length !== org.ownerIds.length || owners.some((id) => !org.ownerIds.includes(id));
  if (addOwners.length || removeOwners.length) {
    say(ownersChange ? `Owners: ${org.ownerIds.length} to ${owners.length}${addOwners.length ? `, adding ${addOwners.join(", ")}` : ""}${removeOwners.length ? `, removing ${removeOwners.join(", ")}` : ""}.` : "Owners: no change.");
    if (owners.length > MAX_ORGANISATION_OWNERS) refuse(TOOL, `An organisation has at most ${MAX_ORGANISATION_OWNERS} owners.`);
  }
  if (!planChange && !nameChange && !ownersChange) {
    say("nothing to change");
    return;
  }

  const blocked = guardChanges(previews, ALLOW);
  if (!APPLY) {
    if (blocked) say(`--apply would be refused: ${blocked}`);
    say("dry run: pass --apply --by <label> to write");
    return;
  }
  if (blocked) refuse(TOOL, blocked);

  if (planChange && nextPlanId !== null) {
    const res = await tenantLib.setOrganisationPlan(org.id, nextPlanId, actor!);
    if (!res) refuse(TOOL, `${org.id} went missing.`);
    say(`done: ${org.id} is on ${planById(nextPlanId)!.name}.`);
    if (res.missingBrands.length) say(`Missing brands skipped: ${res.missingBrands.join(", ")}.`);
    if (res.unlinkedBrands.length) say(`Brands pointing at another organisation skipped: ${res.unlinkedBrands.join(", ")}. Run scripts/backfill-organisations.ts --check.`);
  }
  if (nameChange && nextName !== null) {
    const res = await tenantLib.setOrganisationName(org.id, nextName, actor!);
    if (!res) refuse(TOOL, `${org.id} went missing.`);
    say(`done: ${org.id} is named "${res.name}".`);
  }
  if (ownersChange) {
    const res = await tenantLib.setOrganisationOwners(org.id, { add: addOwners, remove: removeOwners }, actor!);
    if (res === null) refuse(TOOL, `${org.id} went missing.`);
    if (res === "too_many") refuse(TOOL, `An organisation has at most ${MAX_ORGANISATION_OWNERS} owners.`);
    say(`done: ${org.id} has ${count(res.ownerIds.length, "owner")}.`);
  }
}

main().catch((err) => {
  console.error(`[${TOOL}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
