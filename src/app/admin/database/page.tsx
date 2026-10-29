import { redirect } from "next/navigation";
import { StubPage } from "@/components/admin/StubPage";
import { isOneViewEnabled } from "@/lib/audience/flags";

export const dynamic = "force-dynamic";

export default function MasterDatabasePage() {
  // The one People list (AUDIENCE_ONE_VIEW_ENABLED) is what this placeholder promised.
  if (isOneViewEnabled()) redirect("/admin/crm");
  return (
    <StubPage
      title="Master Database"
      description="The queryable system of record for all signups, segments, and events across every launch — exportable and pipeline-ready."
    />
  );
}
