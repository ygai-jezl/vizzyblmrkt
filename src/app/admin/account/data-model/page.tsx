import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isFieldFiltersEnabled, isFieldsEnabled } from "@/lib/audience/peopleFlags";
import { loadPeopleConnections } from "@/lib/audience/personSync";
import { readOnlyFieldDefs } from "@/lib/audience/readOnlyFields";
import { ENVIRONMENT_LABEL, environmentOf, productNameOf } from "@/lib/connect/environments";
import { forTenant } from "@/lib/tenant";
import { DataModel } from "@/components/admin/audience/DataModel";

export const dynamic = "force-dynamic";

/**
 * Settings › Data model (AUDIENCE_FIELDS_ENABLED): the fields on People and Companies. The fields
 * from elsewhere are worked out here, from the brand's launches and products; the brand's own
 * fields load in the browser. Admins change them; members read.
 */
export default async function DataModelPage() {
  const ctx = await requireAdminContext();
  if (!isFieldsEnabled()) notFound();
  const [campaigns, connections] = await Promise.all([
    forTenant(ctx).campaigns.find({ limit: 500 }).catch(() => []),
    loadPeopleConnections(ctx).catch(() => new Map()),
  ]);
  const named = [...connections.values()].map((c) => {
    const env = environmentOf(c);
    return { id: c.id, catalog: c.catalog, name: `${productNameOf(c)}${env ? ` · ${ENVIRONMENT_LABEL[env]}` : ""}` };
  });
  const sources = { campaigns, connections: named };
  return (
    <DataModel
      canEdit={ctx.role === "admin"}
      filters={isFieldFiltersEnabled()}
      readOnly={{ person: readOnlyFieldDefs("person", sources), company: readOnlyFieldDefs("company", sources) }}
    />
  );
}
