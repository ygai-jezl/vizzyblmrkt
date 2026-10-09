import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isPersonViewEnabled } from "@/lib/audience/flags";
import { PersonView } from "@/components/admin/people/PersonView";

export const dynamic = "force-dynamic";

/**
 * One product user, whole (AUDIENCE_PERSON_VIEW). The view loads its own data in
 * the browser, so every date reads in the viewer's time zone.
 */
export default async function PersonPage({ params }: { params: Promise<{ personId: string }> }) {
  const ctx = await requireAdminContext();
  if (!isPersonViewEnabled()) notFound();
  const { personId } = await params;
  return <PersonView personId={personId} canEdit={ctx.role === "admin"} />;
}
