import { requireAdminContext } from "@/lib/auth/session";
import { fetchAdminSignupRows } from "@/lib/admin/signups";
import { SignupsTable } from "@/components/admin/SignupsTable";
import { SignupsTabs } from "@/components/admin/SignupsTabs";

export const dynamic = "force-dynamic";

export default async function SignupsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await requireAdminContext();
  const sp = await searchParams;
  const mode = sp.status === "offboarded" ? "offboarded" : "active";
  // Global view across all launches. Per-launch signups live under
  // /admin/launches/[id]/signups (same helper, campaign-scoped, with rank).
  const rows = await fetchAdminSignupRows(ctx, { status: mode });

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Signups</h1>
        <span className="text-sm text-neutral-500">{rows.length} shown</span>
      </div>
      <SignupsTabs base="/admin/signups" active={mode} />
      <SignupsTable initialRows={rows} mode={mode} />
    </div>
  );
}
