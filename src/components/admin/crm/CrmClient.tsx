"use client";

import { useEffect, useState } from "react";
import { ClipboardPaste } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Contact } from "@/lib/types/contact";
import type { Company } from "@/lib/types/company";
import type { EngagedContact } from "@/lib/types/engagedContact";
import { ContactsView } from "./ContactsView";
import { CompaniesView } from "./CompaniesView";
import { EngagedView } from "./EngagedView";
import { ProductUsersView } from "./ProductUsersView";
import { PeopleList } from "../people/PeopleList";
import { AudienceList } from "../audience/AudienceList";
import { InvestorBoard } from "../investors/InvestorBoard";
import { PASTE_WORDS } from "@/lib/crm/paste/words";
import { PasteListSheet } from "./PasteListSheet";
import { withoutPaste } from "./pasteApi";

const TABS = ["contacts", "product", "people", "companies", "engaged", "investors"] as const;
type Tab = (typeof TABS)[number];

const pill = (active: boolean) =>
  `rounded-md border px-3 py-1 ${
    active
      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
      : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
  }`;

export function CrmClient({
  isAdmin,
  initialContacts,
  contactsCursor,
  initialCompanies,
  companiesCursor,
  initialEngaged = [],
  engagedCursor = null,
  initialQuery,
  initialLaunch = null,
  audience = null,
  initialTab,
  fields = false,
  fieldFilters = false,
  initialGroup = null,
  canAddPerson = false,
  newPerson = false,
  newPersonDraft = null,
  views = null,
  investors = null,
  canPaste = false,
  pasteBatchId = null,
}: {
  isAdmin: boolean;
  initialContacts: Contact[];
  contactsCursor: string | null;
  initialCompanies: Company[];
  companiesCursor: string | null;
  initialEngaged?: EngagedContact[];
  engagedCursor?: string | null;
  /** The contacts search the page arrived with (?q=). */
  initialQuery?: string;
  /** Nav v2 phase 3: people from one launch (?launch=). */
  initialLaunch?: { id: string; name: string } | null;
  /**
   * Nav v2 phase 3: Audience is the one home for people — signups and product users.
   * `personView` (AUDIENCE_PERSON_VIEW): the fuller Product users list, whose rows open a person.
   */
  audience?: { productUsers: boolean; personView?: boolean; oneView?: boolean } | null;
  /** With the person view: the tab the page arrived on (?tab=). */
  initialTab?: string;
  /** Fields are on (AUDIENCE_FIELDS_ENABLED): company fields on each company. */
  fields?: boolean;
  /** Field filters are on (AUDIENCE_FIELD_FILTERS_ENABLED): a menu per filter and per field on People. */
  fieldFilters?: boolean;
  /** A product group the page arrived with (?group=), with its name. */
  initialGroup?: { tag: string; label: string } | null;
  /** An admin with New person on (AUDIENCE_ADD_PERSON_ENABLED): People has a New person button. */
  canAddPerson?: boolean;
  /** The page arrived from ⌘K's New person (?new=person). */
  newPerson?: boolean;
  /** The page arrived from a form Vizzy filled in (?draft=), by the draft's id. */
  newPersonDraft?: string | null;
  /** Views on People (CRM_VIEWS_ENABLED), and a saved view the page arrived with (?view=). */
  views?: { initialViewId: string | null } | null;
  /**
   * The investor or funding board (RAISE_PIPELINE_ENABLED, with the one People list), for a brand
   * set up for it: its tab's name, Investors or Funding. Null: no tab, and ?tab=investors lands on People.
   */
  investors?: { tab: string } | null;
  /**
   * An admin with Paste a list on (RAISE_PASTE_ENABLED): Paste a list beside the tabs, and Remove
   * company on a company with no people.
   */
  canPaste?: boolean;
  /** The page arrived from Review or Vizzy's card on a waiting list (?paste=), by its id. */
  pasteBatchId?: string | null;
}) {
  /** AUDIENCE_ONE_VIEW_ENABLED: one People tab in place of Signups and Product users. */
  const oneView = Boolean(audience?.oneView);
  const personView = oneView || Boolean(audience?.personView && audience.productUsers);
  const first: Tab = oneView ? "people" : "contacts";
  const [picked, setPicked] = useState<Tab>(first);
  // With the person view the tab lives in the address bar (?tab=), so Back from a person's page
  // returns to the tab they were opened from. It is read from the router, not from the page's
  // props: Back restores the page as it was first rendered, with the address as it was left.
  const params = useSearchParams();
  const found = personView ? TABS.find((t) => t === (params.get("tab") ?? initialTab)) : undefined;
  // Links to the old tabs land on People; a link to a board this brand doesn't have lands on the first tab.
  const asked = found === "investors" && !investors ? undefined : oneView && (found === "contacts" || found === "product") ? "people" : found;
  const tab: Tab = personView ? (asked ?? first) : picked;
  const setTab = (next: Tab) => {
    if (!personView) return setPicked(next);
    const url = new URL(window.location.href);
    if (next === first) url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    // `null`, not the router's own state object: that is how the router learns the new address.
    window.history.replaceState(null, "", url);
  };
  const router = useRouter();
  /** Paste a list is open, on a waiting list (from ?paste=) or on an empty box. */
  const [pasting, setPasting] = useState<{ batchId: string | null } | null>(canPaste && pasteBatchId ? { batchId: pasteBatchId } : null);
  /** Bumped once a pasted list is added, so People and Companies load again. */
  const [added, setAdded] = useState(0);
  // Review's link or Vizzy's card while the page is already open.
  useEffect(() => {
    if (canPaste && pasteBatchId) setPasting({ batchId: pasteBatchId });
  }, [canPaste, pasteBatchId]);
  const closePaste = () => {
    // Drop ?paste=, keeping the tab, so the link can open the list again.
    if (pasting?.batchId && new URLSearchParams(window.location.search).has("paste")) {
      router.replace(withoutPaste(window.location.pathname, window.location.search));
    }
    setPasting(null);
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {oneView ? (
          <button className={pill(tab === "people")} onClick={() => setTab("people")}>
            People
          </button>
        ) : (
          <button className={pill(tab === "contacts")} onClick={() => setTab("contacts")}>
            {audience ? "Signups" : "Contacts"}
          </button>
        )}
        {audience?.productUsers && !oneView ? (
          <button className={pill(tab === "product")} onClick={() => setTab("product")}>
            Product users
          </button>
        ) : null}
        <button className={pill(tab === "companies")} onClick={() => setTab("companies")}>
          Companies
        </button>
        <button className={pill(tab === "engaged")} onClick={() => setTab("engaged")}>
          Engaged
        </button>
        {investors ? (
          <button className={pill(tab === "investors")} onClick={() => setTab("investors")}>
            {investors.tab}
          </button>
        ) : null}
        {canPaste ? (
          <button
            type="button"
            onClick={() => setPasting({ batchId: null })}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            <ClipboardPaste size={14} aria-hidden /> {PASTE_WORDS.button}
          </button>
        ) : null}
      </div>
      {pasting ? (
        <PasteListSheet
          key={pasting.batchId ?? "box"}
          open
          batchId={pasting.batchId}
          onClose={closePaste}
          onAdded={() => setAdded((n) => n + 1)}
        />
      ) : null}
      {tab === "people" ? (
        <AudienceList
          key={`${initialGroup?.tag ?? "list"}:${added}`}
          initialQuery={initialQuery}
          initialLaunch={initialLaunch}
          fieldFilters={fieldFilters}
          initialGroup={initialGroup}
          canAddPerson={canAddPerson}
          fields={fields}
          newPerson={newPerson}
          newPersonDraft={newPersonDraft}
          views={views ? { isAdmin, initialViewId: views.initialViewId } : null}
        />
      ) : tab === "contacts" ? (
        <ContactsView
          isAdmin={isAdmin}
          initialRows={initialContacts}
          initialCursor={contactsCursor}
          initialQuery={initialQuery}
          initialLaunch={initialLaunch}
        />
      ) : tab === "product" ? (
        personView ? <PeopleList /> : <ProductUsersView />
      ) : tab === "investors" && investors ? (
        <InvestorBoard />
      ) : tab === "companies" ? (
        <CompaniesView
          key={`companies:${added}`}
          isAdmin={isAdmin}
          initialRows={initialCompanies}
          initialCursor={companiesCursor}
          reload={added > 0}
          fields={fields}
          canRemove={canPaste}
        />
      ) : (
        <EngagedView isAdmin={isAdmin} initialRows={initialEngaged} initialCursor={engagedCursor} />
      )}
    </div>
  );
}
