import { StubPage } from "@/components/admin/StubPage";

export const dynamic = "force-dynamic";

export default function MasterDatabasePage() {
  return (
    <StubPage
      title="Master Database"
      description="The queryable system of record for all signups, segments, and events across every launch — exportable and pipeline-ready."
    />
  );
}
