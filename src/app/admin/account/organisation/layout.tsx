import { notFound } from "next/navigation";
import { loadOrganisationPageOwner } from "@/lib/connectors/organisationPage";

export const dynamic = "force-dynamic";

/**
 * Settings › Organisation (Connectors 3): only for an owner of the brand's organisation who is an
 * admin of the brand they are in, both read live, while sharing or the join is on. Everyone else
 * finds no page, and no tab leads here.
 */
export default async function OrganisationLayout({ children }: { children: React.ReactNode }) {
  if (!(await loadOrganisationPageOwner())) notFound();
  return <>{children}</>;
}
