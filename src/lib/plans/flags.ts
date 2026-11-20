import { PlanIdSchema, type PlanId } from "@/lib/types/organisation";

/**
 * Organisations and plans (src/lib/plans). Each switch is off unless "true": listed "false" in
 * apphosting.yaml and turned on per deployment. Off, a copy is self-hosted: every brand may use
 * every feature its switch turns on, and organisation records and plan copies are ignored.
 */

/**
 * The plan layer in brand access and monthly caps, an organisation for each brand made in the
 * app, and the figures behind Plan and usage.
 */
export function isPlansEnabled(): boolean {
  return process.env.PLANS_ENABLED === "true";
}

/**
 * Client mirror (build time): the Plan and usage tab, its breadcrumb and Cmd K words, the New
 * brand note, and the /help/plan-and-usage page. Changing it needs a new build.
 */
export function isPlansUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PLANS_ENABLED === "true";
}

/**
 * The plan an organisation made in the app starts on (the PLANS_NEW_ORGANISATION_PLAN setting).
 * Unset, empty or unknown gives self_hosted, so a copy that turns plans on stays open. Server
 * only: read when PLANS_ENABLED is on.
 */
export function newOrganisationPlan(): PlanId {
  const parsed = PlanIdSchema.safeParse((process.env.PLANS_NEW_ORGANISATION_PLAN ?? "").trim().toLowerCase());
  return parsed.success ? parsed.data : "self_hosted";
}
