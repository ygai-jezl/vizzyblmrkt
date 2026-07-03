import { requireAdminContext } from "@/lib/auth/session";
import { listCompanies, listContacts, listEngagedContacts } from "@/lib/admin/crm";
import { CrmClient } from "@/components/admin/crm/CrmClient";

export const dynamic = "force-dynamic";

/**
 * Unified CRM — tenant-wide view of every contact across all launches, with
 * company intelligence (Agent 1) and per-contact email history. Server-renders
 * the first page of each tab; the client owns search/filter/pagination.
 */
export default async function CrmPage() {
  const ctx = await requireAdminContext();
  const [companies, contacts, engaged] = await Promise.all([
    listCompanies(ctx, {}),
    listContacts(ctx, {}),
    listEngagedContacts(ctx, {}),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Unified CRM</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Every contact across all launches, with company intelligence and email history.
        </p>
      </div>
      <CrmClient
        isAdmin={ctx.role === "admin"}
        initialContacts={contacts.items}
        contactsCursor={contacts.nextCursor}
        initialCompanies={companies.items}
        companiesCursor={companies.nextCursor}
        initialEngaged={engaged.items}
        engagedCursor={engaged.nextCursor}
      />
    </div>
  );
}
