"use client";

import { useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";

/**
 * Domains tab of Account Settings. UI-only placeholder: lets a user add domains
 * they own, see the DNS records (SPF/DKIM/DMARC) they'd add to verify, and set a
 * global default email sender. State is local and NOT persisted — persistence and
 * live DNS verification land in a follow-up PR. The mock DNS rows and local state
 * are the seam where the backend will slot in.
 */

type DomainStatus = "pending" | "verified";

interface UiDomain {
  id: string;
  domain: string;
  status: DomainStatus;
}

interface DnsRecord {
  type: "TXT" | "CNAME";
  host: string;
  value: string;
}

/** Stable per-row id so React keys survive add/remove. */
const uid = () => crypto.randomUUID();

/** Illustrative DNS records for a domain (replaced with real values by the backend PR). */
function mockDnsRecords(domain: string): DnsRecord[] {
  return [
    { type: "TXT", host: domain, value: "v=spf1 include:_spf.vizzybl.com ~all" },
    { type: "CNAME", host: `vzbl._domainkey.${domain}`, value: "vzbl.dkim.vizzybl.com" },
    { type: "TXT", host: `_dmarc.${domain}`, value: "v=DMARC1; p=none;" },
  ];
}

const INPUT_CLASS =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

export function DomainsSettings() {
  const [domains, setDomains] = useState<UiDomain[]>([]);
  const [newDomain, setNewDomain] = useState("");

  // Global default sender identity (local-only placeholder).
  const [senderName, setSenderName] = useState("");
  const [fromLocalPart, setFromLocalPart] = useState("");
  const [fromDomain, setFromDomain] = useState("");
  const [replyTo, setReplyTo] = useState("");

  const verifiedDomains = domains.filter((d) => d.status === "verified");

  function addDomain() {
    const value = newDomain.trim().toLowerCase();
    if (!value) return;
    if (domains.some((d) => d.domain === value)) {
      setNewDomain("");
      return;
    }
    setDomains((prev) => [...prev, { id: uid(), domain: value, status: "pending" }]);
    setNewDomain("");
  }

  function verifyDomain(id: string) {
    setDomains((prev) =>
      prev.map((d) => (d.id === id ? { ...d, status: "verified" } : d)),
    );
  }

  function removeDomain(id: string) {
    setDomains((prev) => prev.filter((d) => d.id !== id));
  }

  return (
    <div className="space-y-8">
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
        Persistence and live DNS verification land in a follow-up PR. Changes here are
        not saved yet.
      </p>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Your domains</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Add a domain you own and verify it via DNS so you can send launch emails
            from a custom sender and reply-to address.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDomain();
              }
            }}
            placeholder="mail.example.com"
            aria-label="Domain to add"
            className={`${INPUT_CLASS} max-w-xs`}
          />
          <button
            type="button"
            onClick={addDomain}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            disabled={!newDomain.trim()}
          >
            Add domain
          </button>
        </div>

        {domains.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No domains yet.
          </p>
        ) : (
          <div className="space-y-4">
            {domains.map((d) => (
              <DomainCard
                key={d.id}
                domain={d}
                onVerify={() => verifyDomain(d.id)}
                onRemove={() => removeDomain(d.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Default email sender</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Used as the default sender across all launches once a domain is verified.
            Individual launches can override these.
          </p>
        </div>

        <div className="grid gap-4 md:max-w-lg">
          <div className="space-y-1">
            <label className="block text-sm font-medium">Sender name</label>
            <input
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="Acme Team"
              className={INPUT_CLASS}
            />
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-medium">From address</label>
            <div className="flex items-center gap-2">
              <input
                value={fromLocalPart}
                onChange={(e) => setFromLocalPart(e.target.value)}
                placeholder="hello"
                aria-label="From address local part"
                className={`${INPUT_CLASS} flex-1`}
              />
              <span className="text-sm text-neutral-400">@</span>
              <select
                value={fromDomain}
                onChange={(e) => setFromDomain(e.target.value)}
                aria-label="From address domain"
                className={`${INPUT_CLASS} flex-1`}
                disabled={verifiedDomains.length === 0}
              >
                {verifiedDomains.length === 0 ? (
                  <option value="">Verify a domain first</option>
                ) : (
                  <>
                    <option value="">Select a domain</option>
                    {verifiedDomains.map((d) => (
                      <option key={d.id} value={d.domain}>
                        {d.domain}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-medium">Reply-to address</label>
            <input
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="replies@mail.example.com"
              className={INPUT_CLASS}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: DomainStatus }) {
  const styles =
    status === "verified"
      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
      : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>
      {status === "verified" ? "Verified" : "Pending"}
    </span>
  );
}

function DomainCard({
  domain,
  onVerify,
  onRemove,
}: {
  domain: UiDomain;
  onVerify: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-4 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{domain.domain}</span>
          <StatusBadge status={domain.status} />
        </div>
        <div className="flex items-center gap-2">
          {domain.status === "pending" ? (
            <button
              type="button"
              onClick={onVerify}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Verify
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${domain.domain}`}
            className="grid h-8 w-8 place-items-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {domain.status === "pending" ? (
        <DnsRecordsTable records={mockDnsRecords(domain.domain)} />
      ) : (
        <p className="text-sm text-neutral-500">
          This domain is verified and ready to use as an email sender.
        </p>
      )}
    </div>
  );
}

function DnsRecordsTable({ records }: { records: DnsRecord[] }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500">
        Add these records at your DNS provider, then click Verify.
      </p>
      <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Type</th>
              <th scope="col" className="px-3 py-2 font-medium">Host (Name)</th>
              <th scope="col" className="px-3 py-2 font-medium">Value</th>
              <th scope="col" className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
            {records.map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-2 font-mono">{r.type}</td>
                <td className="px-3 py-2 font-mono break-all">{r.host}</td>
                <td className="px-3 py-2 font-mono break-all">{r.value}</td>
                <td className="px-3 py-2 text-right">
                  <CopyButton value={r.value} label={`Copy ${r.type} value`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — value is selectable as a fallback */
        }
      }}
      className="inline-grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
