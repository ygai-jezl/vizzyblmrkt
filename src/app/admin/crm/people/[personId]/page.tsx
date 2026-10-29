import { notFound, redirect } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isOneViewEnabled, isPersonBriefEnabled, isPersonViewEnabled } from "@/lib/audience/flags";
import { isPersonId, personHref } from "@/lib/audience/paths";
import { personIdOf, personKeyOf } from "@/lib/audience/personSync";
import { forTenant } from "@/lib/tenant";
import { PersonView } from "@/components/admin/people/PersonView";
import { WholePersonView } from "@/components/admin/audience/WholePersonView";

export const dynamic = "force-dynamic";

/**
 * One person. With the one view on (AUDIENCE_ONE_VIEW_ENABLED) that's the whole person,
 * by their person record's id, and a product user's link forwards to it. Otherwise one
 * product user (AUDIENCE_PERSON_VIEW). The views load their own data in the browser, so
 * every date reads in the viewer's time zone.
 */
export default async function PersonPage({ params }: { params: Promise<{ personId: string }> }) {
  const ctx = await requireAdminContext();
  const { personId } = await params;
  const oneView = isOneViewEnabled();
  if (personId.startsWith("ct_")) {
    if (!oneView || !isPersonId(personId)) notFound();
    return <WholePersonView personId={personId} canEdit={ctx.role === "admin"} vizzy={isPersonBriefEnabled()} productView={isPersonViewEnabled()} />;
  }
  if (oneView && isPersonId(personId)) {
    // A product user's old link: their whole person, once their record holds them (a sandbox test user has none).
    const repo = forTenant(ctx);
    const user = await repo.productUsers.getById(personId).catch(() => null);
    if (user?.status === "active") {
      const wholeId = personIdOf(ctx.tenantId, personKeyOf(user));
      const whole = await repo.contacts.getById(wholeId).catch(() => null);
      if (whole?.products?.some((x) => x.productUserId === user.id)) redirect(personHref(wholeId));
    }
  }
  if (!isPersonViewEnabled()) notFound();
  return <PersonView personId={personId} canEdit={ctx.role === "admin"} vizzy={isPersonBriefEnabled()} />;
}
