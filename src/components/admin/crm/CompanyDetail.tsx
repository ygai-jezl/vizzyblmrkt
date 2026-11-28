"use client";

import { useEffect, useState } from "react";
import type { Contact } from "@/lib/types/contact";
import type { Company } from "@/lib/types/company";
import { Modal } from "@/components/admin/email/Modal";
import { COMPANY_REMOVE, companyPastedLine } from "@/lib/crm/paste/words";
import { FieldsPanel } from "../audience/FieldsPanel";
import { Banner } from "../connect/ui";
import { day } from "../people/format";
import { removeCompany, removeError } from "./pasteApi";

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

/** Where a company added from a pasted list came from, or null for any other company. */
export function pastedLine(company: Pick<Company, "addedBy">): string | null {
  return company.addedBy?.via === "paste" ? companyPastedLine(day(company.addedBy.at), company.addedBy.source ?? null) : null;
}

export function CompanyDetail({
  companyId,
  isAdmin,
  onClose,
  fields = false,
  canRemove = false,
  onRemoved,
}: {
  companyId: string;
  isAdmin: boolean;
  onClose: () => void;
  /** Company fields are on (AUDIENCE_FIELDS_ENABLED): the brand's own company fields. */
  fields?: boolean;
  /** An admin with Paste a list on (RAISE_PASTE_ENABLED): Remove company, while it has no people. */
  canRemove?: boolean;
  /** The company was removed: the list drops its row. */
  onRemoved?: (id: string) => void;
}) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeFailed, setRemoveFailed] = useState<string | null>(null);

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

  async function remove() {
    if (!window.confirm(COMPANY_REMOVE.confirm)) return;
    setRemoving(true);
    setRemoveFailed(null);
    const r = await removeCompany(companyId);
    setRemoving(false);
    if (!r.ok) return setRemoveFailed(removeError(r));
    onRemoved?.(companyId);
    onClose();
  }

  const company = data?.company;
  const p = company?.profile;
  const pasted = company ? pastedLine(company) : null;

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
            <div className="flex flex-wrap gap-2">
              {canRemove && isAdmin && data.contacts.length === 0 ? (
                <button
                  disabled={removing}
                  onClick={() => void remove()}
                  className="rounded-md border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  {COMPANY_REMOVE.button}
                </button>
              ) : null}
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
          </div>
          {pasted ? <p className="text-xs text-neutral-500">{pasted}</p> : null}
          {removeFailed ? <Banner tone="err">{removeFailed}</Banner> : null}

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

          {fields ? <FieldsPanel object="company" recordId={company.id} initialValues={company.fields ?? {}} canEdit={isAdmin} title="Company fields" /> : null}

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
