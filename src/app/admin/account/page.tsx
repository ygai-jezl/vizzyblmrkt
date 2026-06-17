import { requireAdminContext } from "@/lib/auth/session";
import { DomainsSettings } from "@/components/admin/DomainsSettings";

export const dynamic = "force-dynamic";

/** Domains tab (default) of Account Settings. */
export default async function AccountDomainsPage() {
  await requireAdminContext();
  return <DomainsSettings />;
}
