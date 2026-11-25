import { notFound } from "next/navigation";
import { OrganisationBrandsView } from "@/components/admin/connectors/OrganisationBrandsView";
import { SharedConnectionsView } from "@/components/admin/connectors/SharedConnectionsView";
import { BRANDS_COPY, NOTE_ERR, SHARED_COPY } from "@/components/admin/connectors/words";
import { organisationBrandsScreen, type OrganisationBrandsScreen } from "@/lib/connectors/organisationBrands";
import { sharedConnectionsScreen, type SharedConnectionsScreen } from "@/lib/connectors/organisationConnect";
import type { OrganisationOwner } from "@/lib/connectors/organisationOwner";
import { loadOrganisationPageOwner, organisationSections } from "@/lib/connectors/organisationPage";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

async function soft<T>(what: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (err) {
    console.warn(`[organisation] ${what} didn't load`, err instanceof Error ? err.message.slice(0, 200) : "error");
    return null;
  }
}

/**
 * Settings › Organisation, read on the server for an owner: Shared connections while sharing is on
 * (CONNECTORS_SHARING_ENABLED), the organisation's connections from every region and who gets which
 * part, and Brands while the join is on (ORGANISATION_JOIN_ENABLED), its brands with Bring in and
 * Move out. A connect or sign in for the organisation comes back here (`status`, `connection`, and
 * `reason` when it didn't finish).
 */
export default async function OrganisationPage({ searchParams }: Props) {
  const owner: OrganisationOwner | null = await loadOrganisationPageOwner();
  if (!owner) notFound();
  const sections = organisationSections();
  const sp = await searchParams;
  const [shared, brands]: [SharedConnectionsScreen | null, OrganisationBrandsScreen | null] = await Promise.all([
    sections.sharing ? soft("Shared connections", () => sharedConnectionsScreen(owner)) : Promise.resolve(null),
    sections.brands ? soft("Brands", () => organisationBrandsScreen(owner)) : Promise.resolve(null),
  ]);
  return (
    <div className="space-y-8">
      {sections.sharing ? (
        shared ? (
          <SharedConnectionsView screen={shared} back={{ status: one(sp.status), connection: one(sp.connection), reason: one(sp.reason) }} now={new Date().toISOString()} />
        ) : (
          <p role="alert" className={NOTE_ERR}>
            {SHARED_COPY.failed}
          </p>
        )
      ) : null}
      {sections.brands ? (
        brands ? (
          <OrganisationBrandsView screen={brands} />
        ) : (
          <p role="alert" className={NOTE_ERR}>
            {BRANDS_COPY.failed}
          </p>
        )
      ) : null}
    </div>
  );
}
