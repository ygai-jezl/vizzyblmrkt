"use client";

import { useCallback, useState } from "react";
import type { Contact } from "@/lib/types/contact";
import { INVITE_STAGE_LABEL, type InviteStage } from "@/lib/invites/inviteStage";

/** Nav v2 phase 4: the contacts API adds each row's furthest invite stage when invites are on. */
const inviteStageOf = (c: Contact): InviteStage | null => (c as Contact & { invite?: InviteStage | null }).invite ?? null;
import { ContactDetail } from "./ContactDetail";

const chip = (active: boolean) =>
  `rounded-full border px-3 py-1 text-xs ${
    active
      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
      : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
  }`;

function fullName(c: Contact): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || "—";
}

export function ContactsView({
  isAdmin,
  initialRows,
  initialCursor,
  initialQuery = "",
  initialLaunch = null,
}: {
  isAdmin: boolean;
  initialRows: Contact[];
  initialCursor: string | null;
  /** A search the rows were already filtered by (⌘K "Search people"). */
  initialQuery?: string;
  /** Nav v2 phase 3: the rows are one launch's signups (?launch=). */
  initialLaunch?: { id: string; name: string } | null;
}) {
  // The API applies one primary filter and a search wins over the launch, so a
  // search clears the launch filter rather than pretending to combine them.
  const [launch, setLaunch] = useState(initialLaunch);
  const [rows, setRows] = useState<Contact[]>(initialRows);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [q, setQ] = useState(initialQuery);
  const [corporate, setCorporate] = useState(false);
  const [enriched, setEnriched] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (opts: {
      reset: boolean;
      q: string;
      corporate: boolean;
      enriched: boolean;
      cursor: string | null;
      campaignId?: string | null;
    }) => {
      setLoading(true);
      const p = new URLSearchParams();
      if (opts.q) p.set("q", opts.q);
      else if (opts.campaignId) p.set("campaignId", opts.campaignId);
      if (opts.corporate) p.set("corporate", "1");
      if (opts.enriched) p.set("enriched", "1");
      if (!opts.reset && opts.cursor) p.set("cursor", opts.cursor);
      try {
        const res = await fetch(`/api/admin/crm/contacts?${p.toString()}`);
        const data = (await res.json()) as { contacts: Contact[]; nextCursor: string | null };
        setRows((prev) => (opts.reset ? data.contacts : [...prev, ...data.contacts]));
        setCursor(data.nextCursor);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  function applyFilters(next: { q?: string; corporate?: boolean; enriched?: boolean }) {
    const nq = next.q ?? q;
    const nc = next.corporate ?? corporate;
    const ne = next.enriched ?? enriched;
    setQ(nq);
    setCorporate(nc);
    setEnriched(ne);
    const campaignId = nq ? null : (launch?.id ?? null);
    if (nq && launch) setLaunch(null);
    void load({ reset: true, q: nq, corporate: nc, enriched: ne, cursor: null, campaignId });
  }

  // Client-side refinement: the API applies one primary filter; narrow the rest here.
  const visible = rows.filter(
    (r) => (!corporate || r.isCorporateDomain) && (!enriched || r.enrichment.status === "enriched"),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters({});
          }}
          className="flex-1"
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, or domain…"
            className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700"
          />
        </form>
        {launch ? (
          <a
            href="/admin/crm"
            className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 text-xs font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300"
            title="Show everyone"
          >
            Launch: {launch.name} <span aria-hidden>×</span>
          </a>
        ) : null}
        <button className={chip(corporate)} onClick={() => applyFilters({ corporate: !corporate })}>
          Corporate
        </button>
        <button className={chip(enriched)} onClick={() => applyFilters({ enriched: !enriched })}>
          Enriched
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No contacts match.
        </p>
      ) : (
        <div className="divide-y divide-neutral-100 overflow-hidden rounded-md border border-neutral-200 dark:divide-neutral-900 dark:border-neutral-800">
          {visible.map((c) => {
            const open = expanded === c.id;
            return (
              <div key={c.id}>
                <button
                  onClick={() => setExpanded(open ? null : c.id)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
                >
                  <span className="w-4 text-neutral-400">{open ? "▾" : "▸"}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{fullName(c)}</span>
                  <span className="min-w-0 flex-1 truncate text-neutral-500">{c.email ?? c.phone ?? "—"}</span>
                  <span className="hidden w-40 truncate text-neutral-500 sm:block">{c.emailDomain ?? "—"}</span>
                  {!c.verified ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                      unverified
                    </span>
                  ) : null}
                  {inviteStageOf(c) ? (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-900/40 dark:text-green-300">
                      {INVITE_STAGE_LABEL[inviteStageOf(c)!]}
                    </span>
                  ) : null}
                  {c.isCorporateDomain ? (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                      {c.enrichment.status === "enriched" ? "enriched" : "corporate"}
                    </span>
                  ) : null}
                </button>
                {open ? (
                  <div className="border-t border-neutral-100 bg-neutral-50/50 px-4 py-3 dark:border-neutral-900 dark:bg-neutral-900/30">
                    <ContactDetail contactId={c.id} isAdmin={isAdmin} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {cursor ? (
        <button
          disabled={loading}
          onClick={() => load({ reset: false, q, corporate, enriched, cursor, campaignId: q ? null : (launch?.id ?? null) })}
          className="w-full rounded-md border border-neutral-300 py-2 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
