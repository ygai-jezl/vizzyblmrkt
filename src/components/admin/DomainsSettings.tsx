"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";

/**
 * Domains tab of Account Settings. Lets a tenant add domains they own, publish
 * the DNS records to authenticate them with the email provider (Mandrill), verify
 * them, and set a global default email sender reused across all launches. Backed
 * by /api/admin/account/domains (+ /verify).
 */

type DomainStatus = "pending" | "verified" | "failed";

interface DnsRecord {
  type: string;
  host: string;
  value: string;
  valid: boolean;
}

interface DomainCapabilities {
  email: boolean;
  webRouting: boolean;
}

interface SenderDomain {
  domain: string;
  status: DomainStatus;
  dkimValid: boolean;
  spfValid: boolean;
  records: DnsRecord[];
  addedAt: string;
  lastCheckedAt?: string;
  verifyTxtKey?: string;
  detail?: string;
  capabilities?: DomainCapabilities;
  ownership?: { method: string };
}

interface ConfigResponse {
  senderName: string;
  fromLocalPart: string;
  fromDomain: string;
  replyTo: string;
  privacyPolicyUrl: string;
  domains: SenderDomain[];
  providerConfigured: boolean;
}

const INPUT_CLASS =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const PRIMARY_BTN =
  "rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900";
const OUTLINE_BTN =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900";

export function DomainsSettings() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [providerConfigured, setProviderConfigured] = useState(true);
  const [domains, setDomains] = useState<SenderDomain[]>([]);

  const [senderName, setSenderName] = useState("");
  const [fromLocalPart, setFromLocalPart] = useState("");
  const [fromDomain, setFromDomain] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState("");
  const [senderStatus, setSenderStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyDomain, setBusyDomain] = useState<string | null>(null);
  // Pending DNS-TXT ownership challenges for web routing, keyed by domain.
  const [routingChallenge, setRoutingChallenge] = useState<Record<string, DnsRecord>>({});
  const [routingBusy, setRoutingBusy] = useState<string | null>(null);

  function applyConfig(data: ConfigResponse) {
    setSenderName(data.senderName);
    setFromLocalPart(data.fromLocalPart);
    setFromDomain(data.fromDomain);
    setReplyTo(data.replyTo);
    setPrivacyPolicyUrl(data.privacyPolicyUrl ?? "");
    setDomains(data.domains);
    setProviderConfigured(data.providerConfigured);
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/admin/account/domains");
        if (!res.ok) throw new Error("load_failed");
        const data = (await res.json()) as ConfigResponse;
        if (active) applyConfig(data);
      } catch {
        if (active) setError("Couldn't load your domain settings.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const verifiedDomains = domains.filter((d) => d.status === "verified");
  const hasPendingDomains = domains.some((d) => d.status !== "verified");

  // Latest domains, readable by the background poller without re-subscribing it.
  const domainsRef = useRef(domains);
  domainsRef.current = domains;

  // Quietly re-check one pending domain in the background. Unlike the manual
  // Verify button it never sets busy/error state — a transient provider timeout
  // shouldn't flash UI while polling. Returns false to tell the poller to stop.
  const pollVerify = useCallback(async (domain: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/admin/account/domains/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, background: true }),
      });
      if (!res.ok) return true; // transient — keep polling
      const data = (await res.json()) as {
        domains: SenderDomain[];
        providerConfigured: boolean;
      };
      setDomains(data.domains);
      setProviderConfigured(data.providerConfigured);
      return data.providerConfigured; // stop if the provider got unconfigured
    } catch {
      return true; // network blip — keep polling
    }
  }, []);

  // Auto-poll verification for pending domains so status flips without the admin
  // re-clicking Verify. No new infra: client-side only, paused when the tab is
  // hidden, serialized per tick (the verify route is read-modify-write on one
  // tenant doc), and capped so a tab left open doesn't poll forever.
  useEffect(() => {
    if (!providerConfigured || !hasPendingDomains) return;
    let active = true;
    let running = false; // a tick is mid-flight — prevents overlapping ticks
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const MAX_POLLS = 40; // ~20 min at 30s, then fall back to manual Verify
    const INTERVAL_MS = 30_000;

    const schedule = () => {
      if (active) timer = setTimeout(() => void tick(), INTERVAL_MS);
    };

    const tick = async () => {
      if (!active || running) return; // never overlap two ticks (would race /verify)
      if (document.visibilityState !== "visible") {
        schedule(); // stay alive but idle until the tab is focused again
        return;
      }
      const pending = domainsRef.current.filter((d) => d.status !== "verified");
      if (pending.length === 0 || polls >= MAX_POLLS) return; // all done / gave up
      running = true;
      polls += 1;
      try {
        for (const d of pending) {
          if (!active) return;
          const keepGoing = await pollVerify(d.domain);
          if (!keepGoing) {
            active = false;
            return;
          }
        }
      } finally {
        running = false;
      }
      schedule();
    };

    const onVisible = () => {
      if (active && !running && document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        void tick(); // poll immediately on refocus (unless a tick is already running)
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    schedule();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [providerConfigured, hasPendingDomains, pollVerify]);

  async function addDomain() {
    const value = newDomain.trim().toLowerCase();
    if (!value || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/account/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: value }),
      });
      if (res.status === 400) {
        setError("That doesn't look like a valid domain (e.g. mail.yourbrand.com).");
        return;
      }
      if (!res.ok) throw new Error("add_failed");
      applyConfig((await res.json()) as ConfigResponse);
      setNewDomain("");
    } catch {
      setError("Couldn't add that domain. Please try again.");
    } finally {
      setAdding(false);
    }
  }

  async function verifyDomain(domain: string) {
    setBusyDomain(domain);
    setError(null);
    try {
      const res = await fetch("/api/admin/account/domains/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      if (!res.ok) throw new Error("verify_failed");
      const data = (await res.json()) as {
        ok: boolean;
        reason?: string;
        domains: SenderDomain[];
        providerConfigured: boolean;
      };
      setDomains(data.domains);
      setProviderConfigured(data.providerConfigured);
      if (!data.providerConfigured) {
        setError("Live verification needs an email provider (MANDRILL_API_KEY) configured.");
      }
    } catch {
      setError("Couldn't check that domain. Please try again.");
    } finally {
      setBusyDomain(null);
    }
  }

  async function removeDomain(domain: string) {
    setBusyDomain(domain);
    setError(null);
    try {
      const res = await fetch("/api/admin/account/domains", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      if (!res.ok) throw new Error("remove_failed");
      applyConfig((await res.json()) as ConfigResponse);
    } catch {
      setError("Couldn't remove that domain. Please try again.");
    } finally {
      setBusyDomain(null);
    }
  }

  async function saveSender() {
    // Privacy Policy URL is mandatory — every email footer links to it.
    const privacy = privacyPolicyUrl.trim();
    if (!/^https?:\/\/[^\s"'<>\\]+$/i.test(privacy)) {
      setSenderStatus("error");
      setError("Enter a valid Privacy Policy URL (https://…) — it's required for the email footer.");
      return;
    }
    setError(null);
    setSenderStatus("saving");
    try {
      const res = await fetch("/api/admin/account/domains", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderName, fromLocalPart, fromDomain, replyTo, privacyPolicyUrl: privacy }),
      });
      if (!res.ok) throw new Error("save_failed");
      applyConfig((await res.json()) as ConfigResponse);
      setSenderStatus("saved");
    } catch {
      setSenderStatus("error");
    }
  }

  function mergeDomain(updated: SenderDomain) {
    setDomains((ds) => ds.map((d) => (d.domain === updated.domain ? updated : d)));
  }

  // Enable web routing for a domain: prove ownership (email-match / Mandrill /
  // DNS-TXT) then auto-provision allowedOrigins + reCAPTCHA. A `needsDns` reply
  // means the admin must publish our challenge TXT, then click again to verify.
  async function enableWebRouting(domain: string) {
    setRoutingBusy(domain);
    setError(null);
    try {
      const res = await fetch("/api/admin/account/domains/web-routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        needsDns?: boolean;
        record?: DnsRecord;
        domain?: SenderDomain;
        error?: string;
      };
      if (data.needsDns && data.record) {
        setRoutingChallenge((c) => ({ ...c, [domain]: data.record! }));
        return;
      }
      if (!res.ok || !data.ok || !data.domain) {
        setError(
          data.error === "reserved_domain"
            ? "That domain can't be used for routing."
            : "Couldn't enable widget routing for that domain.",
        );
        return;
      }
      mergeDomain(data.domain);
      setRoutingChallenge((c) => {
        const { [domain]: _drop, ...rest } = c;
        return rest;
      });
    } catch {
      setError("Couldn't enable widget routing. Please try again.");
    } finally {
      setRoutingBusy(null);
    }
  }

  async function disableWebRouting(domain: string) {
    setRoutingBusy(domain);
    setError(null);
    try {
      const res = await fetch("/api/admin/account/domains/web-routing", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = (await res.json().catch(() => ({}))) as { domain?: SenderDomain };
      if (!res.ok || !data.domain) throw new Error("disable_failed");
      mergeDomain(data.domain);
    } catch {
      setError("Couldn't disable widget routing. Please try again.");
    } finally {
      setRoutingBusy(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  return (
    <div className="space-y-8">
      {!providerConfigured ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          No email provider is configured yet (MANDRILL_API_KEY). You can add domains
          and copy their DNS records, but live verification is unavailable until a
          provider is set up.
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </p>
      ) : null}

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
                void addDomain();
              }
            }}
            placeholder="mail.example.com"
            aria-label="Domain to add"
            className={`${INPUT_CLASS} max-w-xs`}
          />
          <button
            type="button"
            onClick={() => void addDomain()}
            className={PRIMARY_BTN}
            disabled={!newDomain.trim() || adding}
          >
            {adding ? "Adding…" : "Add domain"}
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
                key={d.domain}
                domain={d}
                busy={busyDomain === d.domain}
                routingBusy={routingBusy === d.domain}
                routingChallenge={routingChallenge[d.domain]}
                onVerify={() => void verifyDomain(d.domain)}
                onRemove={() => void removeDomain(d.domain)}
                onEnableRouting={() => void enableWebRouting(d.domain)}
                onDisableRouting={() => void disableWebRouting(d.domain)}
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
              onChange={(e) => {
                setSenderName(e.target.value);
                setSenderStatus("idle");
              }}
              placeholder="Acme Team"
              className={INPUT_CLASS}
            />
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-medium">From address</label>
            <div className="flex items-center gap-2">
              <input
                value={fromLocalPart}
                onChange={(e) => {
                  setFromLocalPart(e.target.value);
                  setSenderStatus("idle");
                }}
                placeholder="hello"
                aria-label="From address local part"
                className={`${INPUT_CLASS} flex-1`}
              />
              <span className="text-sm text-neutral-400">@</span>
              <select
                value={fromDomain}
                onChange={(e) => {
                  setFromDomain(e.target.value);
                  setSenderStatus("idle");
                }}
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
                      <option key={d.domain} value={d.domain}>
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
              onChange={(e) => {
                setReplyTo(e.target.value);
                setSenderStatus("idle");
              }}
              placeholder="replies@mail.example.com"
              className={INPUT_CLASS}
            />
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-medium">
              Privacy Policy URL <span className="text-red-500">*</span>
            </label>
            <input
              value={privacyPolicyUrl}
              onChange={(e) => {
                setPrivacyPolicyUrl(e.target.value);
                setSenderStatus("idle");
              }}
              placeholder="https://yourbrand.com/privacy"
              inputMode="url"
              aria-required="true"
              className={INPUT_CLASS}
            />
            <p className="text-xs text-neutral-500">
              Required. Linked in the footer of every email you send (waitlist journeys and
              broadcasts), alongside Unsubscribe and Manage preferences.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void saveSender()}
              className={PRIMARY_BTN}
              disabled={senderStatus === "saving"}
            >
              {senderStatus === "saving" ? "Saving…" : "Save sender"}
            </button>
            {senderStatus === "saved" ? (
              <span className="text-sm text-green-600 dark:text-green-400">Saved.</span>
            ) : senderStatus === "error" ? (
              <span className="text-sm text-red-600 dark:text-red-400">Save failed.</span>
            ) : null}
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
      : status === "failed"
        ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
        : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
  const label =
    status === "verified" ? "Verified" : status === "failed" ? "Failed" : "Pending";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{label}</span>
  );
}

function DomainCard({
  domain,
  busy,
  routingBusy,
  routingChallenge,
  onVerify,
  onRemove,
  onEnableRouting,
  onDisableRouting,
}: {
  domain: SenderDomain;
  busy: boolean;
  routingBusy: boolean;
  routingChallenge?: DnsRecord;
  onVerify: () => void;
  onRemove: () => void;
  onEnableRouting: () => void;
  onDisableRouting: () => void;
}) {
  const webRouting = domain.capabilities?.webRouting ?? false;
  return (
    <div className="space-y-4 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{domain.domain}</span>
          <StatusBadge status={domain.status} />
          {webRouting ? (
            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
              Widget routing
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {domain.status !== "verified" ? (
            <button type="button" onClick={onVerify} className={OUTLINE_BTN} disabled={busy}>
              {busy ? "Checking…" : "Verify"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            aria-label={`Remove ${domain.domain}`}
            className="grid h-8 w-8 place-items-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/40 dark:hover:text-red-400"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {domain.status === "verified" ? (
        <p className="text-sm text-neutral-500">
          This domain is verified and ready to use as an email sender.
        </p>
      ) : (
        <>
          {!domain.verifyTxtKey ? (
            <p className="text-xs text-neutral-400">
              Click Verify to fetch this domain&apos;s ownership record.
            </p>
          ) : null}
          <DnsRecordsTable records={domain.records} />
        </>
      )}

      {domain.detail ? (
        <p className="text-xs text-neutral-400">Provider note: {domain.detail}</p>
      ) : null}

      <div className="space-y-2 border-t border-neutral-100 pt-3 dark:border-neutral-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Embed widget on this domain</p>
            <p className="text-xs text-neutral-500">
              {webRouting
                ? "Your waitlist widget can be served from this domain."
                : "Serve the waitlist widget from this domain (instead of the default platform host)."}
            </p>
          </div>
          {webRouting ? (
            <button
              type="button"
              onClick={onDisableRouting}
              className={OUTLINE_BTN}
              disabled={routingBusy}
            >
              {routingBusy ? "Working…" : "Disable"}
            </button>
          ) : (
            <button
              type="button"
              onClick={onEnableRouting}
              className={OUTLINE_BTN}
              disabled={routingBusy}
            >
              {routingBusy ? "Working…" : routingChallenge ? "Verify ownership" : "Use for widget"}
            </button>
          )}
        </div>

        {!webRouting && routingChallenge ? (
          <div className="space-y-2">
            <p className="text-xs text-neutral-500">
              Publish this DNS record to prove you own the domain, then click
              &ldquo;Verify ownership&rdquo;. (Skipped automatically if you signed in with an
              email at this domain, or it&apos;s already email-verified.)
            </p>
            <DnsRecordsTable records={[routingChallenge]} />
          </div>
        ) : null}
      </div>
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
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 font-medium">Type</th>
              <th scope="col" className="px-3 py-2 font-medium">Host (Name)</th>
              <th scope="col" className="px-3 py-2 font-medium">Value</th>
              <th scope="col" className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
            {records.map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-2">
                  {r.valid ? (
                    <Check size={14} className="text-green-600 dark:text-green-400" aria-label="valid" />
                  ) : (
                    <span className="text-neutral-300 dark:text-neutral-600" aria-label="not yet valid">—</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono">{r.type}</td>
                <td className="px-3 py-2 font-mono break-all">{r.host}</td>
                <td className="px-3 py-2 font-mono break-all">
                  {r.value || <span className="text-neutral-400">—</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  {r.value ? <CopyButton value={r.value} label={`Copy ${r.type} value`} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {records.some((r) => r.host.startsWith("_dmarc.")) ? (
        <p className="text-xs text-neutral-400">
          DMARC isn&apos;t checked automatically — once the <code>_dmarc</code> record is
          published you&apos;re all set.
        </p>
      ) : null}
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
