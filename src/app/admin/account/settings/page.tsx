import { requireAdminContext } from "@/lib/auth/session";
import { AccountSettings } from "@/components/admin/AccountSettings";

export const dynamic = "force-dynamic";

/** Account-wide settings (currently: content-language defaults). */
export default async function AccountSettingsPage() {
  await requireAdminContext();
  return <AccountSettings />;
}
