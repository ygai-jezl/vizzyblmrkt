"use client";

import { useEffect, useState } from "react";
import type { Contact } from "@/lib/types/contact";
import type { Company } from "@/lib/types/company";
import { Modal } from "@/components/admin/email/Modal";

interface DetailResponse {
  company: Company;
  contacts: Contact[];
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-400">{label}</div>
      <div className="mt-0.5 text-sm">{value || "—"}</div>
    </div>
  );
}

export function CompanyDetail({
  companyId,
  isAdmin,
  onClose,
}: {
  companyId: string;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    fetch(`/api/admin/crm/companies/${companyId}`)
      .then((r) => r.json())
      .then((d: DetailResponse) => setData(d))
      .catch(() => {});

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/crm/companies/${companyId}`)
      .then((r) => r.json())
      .then((d: DetailResponse) => {
        if (live) setData(d);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [companyId]);

  async function reEnrich() {
    setBusy(true);
    const res = await fetch(`/api/admin/crm/companies/${companyId}/enrich`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      window.alert("Re-enrich failed.");
      return;
    }
    await reload();
  }

  const company = data?.company;
  const p = company?.profile;

  return (
    <Modal open onClose={onClose} title={company?.name ?? company?.domain ?? "Company"} wide>
      {!data || !company ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-base font-semibold">{company.name ?? company.domain}</div>
              <div className="text-xs text-neutral-500">{company.domain}</div>
            </div>
            {isAdmin ? (
              <button
                disabled={busy}
                onClick={reEnrich}
                className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                {busy ? "Queuing…" : "Re-enrich"}
              </button>
            ) : null}
          </div>

          {p ? (
            <>
              {p.description ? (
                <p className="text-sm text-neutral-600 dark:text-neutral-400">{p.description}</p>
              ) : null}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Field label="Industry" value={p.industry} />
                <Field label="Size" value={p.employeeRange} />
                <Field label="HQ" value={p.hqLocation} />
                <Field label="Founded" value={p.foundedYear ? String(p.foundedYear) : null} />
                <Field label="Funding" value={p.fundingStage} />
                <Field label="Website" value={p.website} />
              </div>
            </>
          ) : (
            <p className="text-sm text-neutral-500">
              Enrichment status: <span className="font-medium">{company.enrichmentStatus}</span>
              {company.lastError ? ` (${company.lastError})` : ""}
            </p>
          )}

          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-neutral-400">
              Contacts ({data.contacts.length})
            </div>
            <ul className="divide-y divide-neutral-100 overflow-hidden rounded-md border border-neutral-200 dark:divide-neutral-900 dark:border-neutral-800">
              {data.contacts.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="flex-1 truncate font-medium">
                    {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                  </span>
                  <span className="flex-1 truncate text-neutral-500">{c.email ?? "—"}</span>
                </li>
              ))}
              {data.contacts.length === 0 ? (
                <li className="px-3 py-2 text-sm text-neutral-400">No contacts.</li>
              ) : null}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}
