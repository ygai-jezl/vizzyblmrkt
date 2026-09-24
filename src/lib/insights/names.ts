import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";

/**
 * People-facing names for the email programmes behind a journey id (nav v2
 * phase 4): a launch's welcome journey (journey_{launch}, or lcjw_… once it
 * has moved to the lifecycle engine), its invites (invite_{launch}) and
 * lifecycle journeys (lcj_…).
 */
export async function emailNames(ctx: TenantContext, journeyIds: string[], db?: FirestoreLike): Promise<Map<string, string>> {
  const repos = forTenant(ctx, db);
  const out = new Map<string, string>();
  const launchIds = new Set<string>();
  const lifecycleIds: string[] = [];
  for (const id of journeyIds) {
    if (id.startsWith("journey_")) launchIds.add(id.slice("journey_".length));
    else if (id.startsWith("invite_")) launchIds.add(id.slice("invite_".length));
    else if (id.startsWith("lcj")) lifecycleIds.push(id);
  }
  const journeys = await Promise.all(lifecycleIds.map((id) => repos.lifecycleJourneys.getById(id).catch(() => null)));
  for (const j of journeys) if (j?.audience?.kind === "waitlist") launchIds.add(j.audience.campaignId);
  const launches = await Promise.all([...launchIds].map((id) => repos.campaigns.getById(id).catch(() => null)));
  const launchName = new Map(launches.filter(Boolean).map((c) => [c!.id, c!.waitlistName]));
  for (const id of journeyIds) {
    if (id.startsWith("journey_")) out.set(id, `Welcome & nurture · ${launchName.get(id.slice(8)) ?? "a launch"}`);
    else if (id.startsWith("invite_")) out.set(id, `Product invite · ${launchName.get(id.slice(7)) ?? "a launch"}`);
  }
  for (const j of journeys) {
    if (!j) continue;
    out.set(j.id, j.audience?.kind === "waitlist" ? `Welcome & nurture · ${launchName.get(j.audience.campaignId) ?? "a launch"}` : j.name);
  }
  return out;
}

/** Where each programme is edited. */
export function emailHref(journeyId: string): string {
  if (journeyId.startsWith("journey_")) return `/admin/launches/${journeyId.slice(8)}/journey`;
  if (journeyId.startsWith("invite_")) return `/admin/launches/${journeyId.slice(7)}/invites`;
  return `/admin/lifecycle/${journeyId}`;
}
