import { notFound } from "next/navigation";
import OrganisationBrandsHelp from "@/components/help/pages/organisation-brands";
import { helpMetadata } from "@/lib/help/metadata";
import { isOrganisationJoinEnabled } from "@/lib/plans/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("organisation-brands");

/** Served only while ORGANISATION_JOIN_ENABLED is on (with PLANS_ENABLED). */
export default function Page() {
  if (!isOrganisationJoinEnabled()) notFound();
  return <OrganisationBrandsHelp />;
}
