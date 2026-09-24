import { requireAdminContext } from "@/lib/auth/session";
import { listCompanies, listContacts, listEngagedContacts } from "@/lib/admin/crm";
import type { ListResult } from "@/lib/admin/crm";
import { CrmClient } from "@/components/admin/crm/CrmClient";
import { isNavV2Enabled, isNavV2Phase2Enabled, isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { forTenant } from "@/lib/tenant";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { withInviteStages } from "@/lib/invites/audience";
import { loadFunnel } from "@/lib/invites/funnel";
import { LaunchFunnel } from "@/components/admin/invites/LaunchFunnel";

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
export default async function CrmPage({ searchParams }: { searchParams: Promise<{ q?: string; launch?: string }> }) {
  const ctx = await requireAdminContext();
  const sp = await searchParams;
  // Nav v2 phase 2: ⌘K "Search people" arrives with ?q=, pre-filtering Contacts.
  const q = isNavV2Phase2Enabled() ? (sp.q ?? "").trim().slice(0, 200) : "";
  // Nav v2 phase 3: a launch's Signups tab links here with ?launch=<id>.
  const phase3 = isNavV2Phase3Enabled();
  const launchId = phase3 && !q ? (sp.launch ?? "").trim().slice(0, 200) : "";
  const launch = launchId ? await forTenant(ctx).campaigns.getById(launchId).catch(() => null) : null;
  const invites = isInvitesUiEnabled() && isInvitesEnabled();
  const [companies, contacts, engaged, funnel] = await Promise.all([
    tab("companies", listCompanies(ctx, {})),
    tab("contacts", listContacts(ctx, q ? { q } : launch ? { campaignId: launch.id } : {})),
    tab("engaged", listEngagedContacts(ctx, {})),
    // Nav v2 phase 4: the growth path in numbers, for this launch or every launch.
    invites ? loadFunnel(ctx, { campaignId: launch?.id ?? null }).catch(() => null) : null,
  ]);
  const contactRows = invites ? await withInviteStages(ctx, contacts.items).catch(() => contacts.items) : contacts.items;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">{isNavV2Enabled() ? "Audience" : "Unified CRM"}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {phase3
            ? "Everyone you reach: your launches' signups, your product's users, and the companies and people engaging with your content."
            : "Every contact across all launches, with company intelligence and email history."}
        </p>
      </div>
      {funnel ? (
        <LaunchFunnel
          funnel={funnel}
          caption={launch ? `${launch.waitlistName}: from waitlist to activated user.` : "Every launch: from waitlist to activated user."}
        />
      ) : null}
      <CrmClient
        isAdmin={ctx.role === "admin"}
        initialContacts={contactRows}
        contactsCursor={contacts.nextCursor}
        initialCompanies={companies.items}
        companiesCursor={companies.nextCursor}
        initialEngaged={engaged.items}
        engagedCursor={engaged.nextCursor}
        initialQuery={q}
        initialLaunch={launch ? { id: launch.id, name: launch.waitlistName } : null}
        audience={phase3 ? { productUsers: isLifecycleEnabled() } : null}
      />
    </div>
  );
}
