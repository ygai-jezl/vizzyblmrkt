"use client";

import { useState } from "react";
import type { Contact } from "@/lib/types/contact";
import type { Company } from "@/lib/types/company";
import type { EngagedContact } from "@/lib/types/engagedContact";
import { ContactsView } from "./ContactsView";
import { CompaniesView } from "./CompaniesView";
import { EngagedView } from "./EngagedView";
import { ProductUsersView } from "./ProductUsersView";
import { PeopleList } from "../people/PeopleList";

const TABS = ["contacts", "product", "companies", "engaged"] as const;
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
  audience?: { productUsers: boolean; personView?: boolean } | null;
  /** With the person view: the tab the page arrived on (?tab=). */
  initialTab?: string;
}) {
  const personView = Boolean(audience?.personView && audience.productUsers);
  const [tab, setTabState] = useState<Tab>(() => {
    const asked = TABS.find((t) => t === initialTab);
    return asked && (asked !== "product" || personView) ? asked : "contacts";
  });
  const setTab = (next: Tab) => {
    setTabState(next);
    if (!personView) return;
    // Keep the tab in the address bar, so Back from a person's page returns to it.
    const url = new URL(window.location.href);
    if (next === "contacts") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-sm">
        <button className={pill(tab === "contacts")} onClick={() => setTab("contacts")}>
          {audience ? "Signups" : "Contacts"}
        </button>
        {audience?.productUsers ? (
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
      {tab === "contacts" ? (
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
