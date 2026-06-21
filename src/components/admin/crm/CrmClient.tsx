"use client";

import { useState } from "react";
import type { Contact } from "@/lib/types/contact";
import type { Company } from "@/lib/types/company";
import { ContactsView } from "./ContactsView";
import { CompaniesView } from "./CompaniesView";

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
}: {
  isAdmin: boolean;
  initialContacts: Contact[];
  contactsCursor: string | null;
  initialCompanies: Company[];
  companiesCursor: string | null;
}) {
  const [tab, setTab] = useState<"contacts" | "companies">("contacts");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-sm">
        <button className={pill(tab === "contacts")} onClick={() => setTab("contacts")}>
          Contacts
        </button>
        <button className={pill(tab === "companies")} onClick={() => setTab("companies")}>
          Companies
        </button>
      </div>
      {tab === "contacts" ? (
        <ContactsView isAdmin={isAdmin} initialRows={initialContacts} initialCursor={contactsCursor} />
      ) : (
        <CompaniesView isAdmin={isAdmin} initialRows={initialCompanies} initialCursor={companiesCursor} />
      )}
    </div>
  );
}
