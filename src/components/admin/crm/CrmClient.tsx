"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Contact } from "@/lib/types/contact";
import type { Company } from "@/lib/types/company";
import type { EngagedContact } from "@/lib/types/engagedContact";
import { ContactsView } from "./ContactsView";
import { CompaniesView } from "./CompaniesView";
import { EngagedView } from "./EngagedView";
import { ProductUsersView } from "./ProductUsersView";
import { PeopleList } from "../people/PeopleList";
import { AudienceList } from "../audience/AudienceList";

const TABS = ["contacts", "product", "people", "companies", "engaged"] as const;
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
  // Links to the old tabs land on People.
  const asked = oneView && (found === "contacts" || found === "product") ? "people" : found;
  const tab: Tab = personView ? (asked ?? first) : picked;
  const setTab = (next: Tab) => {
    if (!personView) return setPicked(next);
    const url = new URL(window.location.href);
    if (next === first) url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    // `null`, not the router's own state object: that is how the router learns the new address.
    window.history.replaceState(null, "", url);
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-sm">
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
      </div>
      {tab === "people" ? (
        <AudienceList initialQuery={initialQuery} initialLaunch={initialLaunch} />
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
      ) : tab === "companies" ? (
        <CompaniesView isAdmin={isAdmin} initialRows={initialCompanies} initialCursor={companiesCursor} />
      ) : (
        <EngagedView isAdmin={isAdmin} initialRows={initialEngaged} initialCursor={engagedCursor} />
      )}
    </div>
  );
}
