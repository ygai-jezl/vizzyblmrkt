import { requireAdminContext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Billing tab placeholder. */
export default async function AccountBillingPage() {
  await requireAdminContext();
  return (
    <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
      Billing is coming soon.
    </p>
  );
}
