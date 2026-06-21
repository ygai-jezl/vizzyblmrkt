"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Contact } from "@/lib/types/contact";
import type { Company } from "@/lib/types/company";
import type { ContactEmailHistoryEntry } from "@/lib/crm/emailHistory";
import { EmailHistoryList } from "./EmailHistoryList";

interface DetailResponse {
  contact: Contact;
  company: Company | null;
  emails: ContactEmailHistoryEntry[];
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-400">{label}</div>
      <div className="text-sm">{value || "—"}</div>
    </div>
  );
}

export function ContactDetail({ contactId, isAdmin }: { contactId: string; isAdmin: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [erasing, setErasing] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/crm/contacts/${contactId}`)
      .then((r) => r.json())
      .then((d: DetailResponse) => {
        if (live) setData(d);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [contactId]);

  if (!data) return <p className="text-sm text-neutral-500">Loading…</p>;
  const { contact, company, emails } = data;

  async function erase() {
    if (!window.confirm("Permanently erase this contact and all their email history? This cannot be undone (GDPR erasure).")) {
      return;
    }
    setErasing(true);
    const res = await fetch(`/api/admin/crm/contacts/${contactId}/erase`, { method: "POST" });
    setErasing(false);
    if (!res.ok) {
      window.alert("Erase failed.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Email" value={contact.email} />
        <Field label="Phone" value={contact.phone} />
        <Field label="Consent" value={contact.consentStatus} />
        <Field label="Campaigns" value={String(contact.campaignIds.length)} />
        <Field label="Total referrals" value={String(contact.totalReferred)} />
        <Field label="UTM source" value={contact.utm?.source ?? null} />
        <Field label="First seen" value={contact.firstSeenAt.slice(0, 10)} />
        <Field label="Domain" value={contact.emailDomain} />
      </div>

      {company ? (
        <div className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <div className="mb-1 text-xs uppercase tracking-wide text-neutral-400">Company</div>
          <div className="font-medium">{company.name ?? company.domain}</div>
          {company.profile ? (
            <div className="mt-1 space-y-0.5 text-neutral-500">
              {company.profile.industry ? <div>{company.profile.industry}</div> : null}
              {company.profile.employeeRange ? <div>{company.profile.employeeRange} employees</div> : null}
              {company.profile.description ? <div className="text-neutral-600 dark:text-neutral-400">{company.profile.description}</div> : null}
            </div>
          ) : (
            <div className="mt-1 text-xs text-neutral-400">Enrichment {company.enrichmentStatus}</div>
          )}
        </div>
      ) : null}

      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-neutral-400">Email history</div>
        <EmailHistoryList emails={emails} />
      </div>

      {isAdmin ? (
        <div>
          <button
            disabled={erasing}
            onClick={erase}
            className="rounded-md border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400"
          >
            {erasing ? "Erasing…" : "Erase (GDPR)"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
