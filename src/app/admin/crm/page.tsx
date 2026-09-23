import { requireAdminContext } from "@/lib/auth/session";
import { listCompanies, listContacts, listEngagedContacts } from "@/lib/admin/crm";
import type { ListResult } from "@/lib/admin/crm";
import { CrmClient } from "@/components/admin/crm/CrmClient";
import { isNavV2Enabled, isNavV2Phase2Enabled } from "@/lib/nav/flags";

export const dynamic = "force-dynamic";

/**
 * Load one tab's first page, degrading to empty (never a full-page 500) if its
 * query fails — e.g. a composite index that is missing or still building. One tab's
 * data problem must not take down the whole CRM; the error is logged, not swallowed.
 */
async function tab<T>(label: string, p: Promise<ListResult<T>>): Promise<ListResult<T>> {
  try {
    return await p;
  } catch (err) {
    console.error(`[crm] ${label} failed to load`, err);
    return { items: [], nextCursor: null };
  }
}

/**
 * Unified CRM — tenant-wide view of every contact across all launches, with
 * company intelligence (Agent 1) and per-contact email history. Server-renders
 * the first page of each tab; the client owns search/filter/pagination.
 */
export default async function CrmPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireAdminContext();
  // Nav v2 phase 2: ⌘K "Search people" arrives with ?q=, pre-filtering Contacts.
  const q = isNavV2Phase2Enabled() ? ((await searchParams).q ?? "").trim().slice(0, 200) : "";
  const [companies, contacts, engaged] = await Promise.all([
    tab("companies", listCompanies(ctx, {})),
    tab("contacts", listContacts(ctx, q ? { q } : {})),
    tab("engaged", listEngagedContacts(ctx, {})),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">{isNavV2Enabled() ? "Audience" : "Unified CRM"}</h1>
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
        initialQuery={q}
      />
    </div>
  );
}
