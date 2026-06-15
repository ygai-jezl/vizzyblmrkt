import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { SignupsTable, type AdminSignupRow } from "@/components/admin/SignupsTable";

export const dynamic = "force-dynamic";

export default async function SignupsPage() {
  const ctx = await requireAdminContext();

  const signups = await forTenant(ctx).signups.find({
    orderBy: [["createdAt", "desc"]],
    limit: 200,
  });

  // Admins own their tenant's data — full (unmasked) PII is shown here.
  const rows: AdminSignupRow[] = signups
    .filter((s) => s.status !== "deleted")
    .map((s) => ({
      id: s.id,
      email: s.email ?? null,
      firstName: s.firstName ?? null,
      lastName: s.lastName ?? null,
      status: s.status,
      amountReferred: s.amountReferred,
      createdAt: s.createdAt,
    }));

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Signups</h1>
        <span className="text-sm text-neutral-500">{rows.length} shown</span>
      </div>
      <SignupsTable initialRows={rows} />
    </div>
  );
}
