"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { personHref } from "@/lib/audience/paths";
import type { PeopleFilters, PeopleRow } from "@/lib/audience/peopleList";
import { api } from "../connect/api";
import { inputClass } from "../connect/ui";
import { Chip, type ChipTone } from "../people/Chip";
import { ago, day } from "../people/format";

/**
 * Audience → People (AUDIENCE_ONE_VIEW_ENABLED): one row per person, whatever brought
 * them: a launch's form, the brand's own site, a connected product, or several. Shows
 * one group at a time, built from the brand's own launches and products; picking a
 * product shows its stages. Every row opens the person.
 */

const STAGE_LABEL = { new: "New", onboarding: "Onboarding", stuck: "Stuck", activated: "Activated", member: "Member", quiet: "Quiet" } as const;
const STAGE_TONE: Record<keyof typeof STAGE_LABEL, ChipTone> = {
  new: "blue",
  onboarding: "blue",
  stuck: "amber",
  activated: "green",
  member: "neutral",
  quiet: "amber",
};
const LAUNCH_STATUS: Record<string, string> = { verified_active: "Confirmed", unverified: "Not confirmed", offboarded: "Offboarded" };
const BLOCKED: Record<string, string> = { unsubscribe: "Unsubscribed", spam: "Marked as spam", hard_bounce: "Address bounced" };

/** The list's address for a group (or a search), and a page after the first. */
function listUrl(f: { show: string; canEmail: boolean; search: string }, next: string | null): string {
  const p = new URLSearchParams();
  if (f.search) p.set("q", f.search);
  else {
    p.set("show", f.show);
    if (f.canEmail) p.set("email", "1");
  }
  if (next) p.set("cursor", next);
  return `/api/admin/audience/list?${p.toString()}`;
}

const pill = (active: boolean) =>
  `rounded-md border px-2.5 py-1 ${
    active
      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
      : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
  }`;

export function AudienceList({ initialQuery = "", initialLaunch = null }: {
  /** A search the page arrived with (?q=, from ⌘K). */
  initialQuery?: string;
  /** A launch the page arrived with (?launch=, from a launch's Signups page). */
  initialLaunch?: { id: string } | null;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState<PeopleFilters | null>(null);
  /** The group shown: a memberOf tag. Within a product, `product` is that product's id. */
  const [show, setShow] = useState(initialLaunch ? `launch:${initialLaunch.id}` : "all");
  const [product, setProduct] = useState<string | null>(null);
  const [canEmail, setCanEmail] = useState(false);
  const [q, setQ] = useState(initialQuery);
  const [search, setSearch] = useState(initialQuery.trim());
  /** Bumped whenever the group or search changes, so a page still loading for the old one is dropped. */
  const generation = useRef(0);
  const [rows, setRows] = useState<PeopleRow[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    void api<PeopleFilters>("/api/admin/audience/list/filters").then((r) => (r.ok ? setFilters(r.data) : setError(true)));
  }, []);

  // A pause after typing before searching, so each key doesn't start a query.
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let alive = true;
    generation.current += 1;
    setRows(null);
    setLoadingMore(false);
    void api<{ people: PeopleRow[]; nextCursor: string | null; total: number | null }>(listUrl({ show, canEmail, search }, null)).then((r) => {
      if (!alive) return;
      if (!r.ok) return setError(true);
      setRows(r.data.people);
      setTotal(r.data.total);
      setCursor(r.data.nextCursor);
    });
    return () => {
      alive = false;
    };
  }, [show, canEmail, search]);

  async function more() {
    if (!cursor || loadingMore) return;
    const asked = generation.current;
    setLoadingMore(true);
    const r = await api<{ people: PeopleRow[]; nextCursor: string | null }>(listUrl({ show, canEmail, search }, cursor));
    if (asked !== generation.current) return;
    setLoadingMore(false);
    // A page that didn't load leaves the rows already shown; the button stays to try again.
    if (!r.ok) return;
    setRows((cur) => [...(cur ?? []), ...r.data.people]);
    setCursor(r.data.nextCursor);
  }

  const pick = (tag: string, inProduct: string | null = null) => {
    setShow(tag);
    setProduct(inProduct);
    setQ("");
    setSearch("");
  };

  if (error) return <p className="text-sm text-red-700 dark:text-red-400">Couldn&rsquo;t load your audience. Reload the page to try again.</p>;
  if (filters && filters.everyone === 0) {
    return (
      <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
        Nobody yet. People appear here when they sign up to a{" "}
        <Link href="/admin/launches" className="underline underline-offset-2">
          launch
        </Link>{" "}
        or a{" "}
        <Link href="/admin/products" className="underline underline-offset-2">
          connected product
        </Link>{" "}
        sends them.
      </p>
    );
  }

  const inProduct = product ? filters?.products.find((p) => p.id === product) : null;
  const multiProduct = (filters?.products.length ?? 0) > 1;

  return (
    <div className="space-y-3">
      {filters ? (
        <div className="flex flex-wrap gap-1.5 text-xs" role="group" aria-label="Who to show">
          <button type="button" aria-pressed={show === "all"} className={pill(show === "all" && !search)} onClick={() => pick("all")}>
            Everyone <span className="tabular-nums opacity-70">{filters.everyone}</span>
          </button>
          {filters.launches
            .filter((l) => l.count > 0)
            .map((l) => (
              <button key={l.id} type="button" aria-pressed={show === `launch:${l.id}`} className={pill(show === `launch:${l.id}` && !search)} onClick={() => pick(`launch:${l.id}`)}>
                {l.name} <span className="tabular-nums opacity-70">{l.count}</span>
              </button>
            ))}
          {filters.via.site > 0 ? (
            <button type="button" aria-pressed={show === "via:site"} className={pill(show === "via:site" && !search)} onClick={() => pick("via:site")}>
              From your site <span className="tabular-nums opacity-70">{filters.via.site}</span>
            </button>
          ) : null}
          {filters.products
            .filter((p) => p.count > 0)
            .map((p) => (
              <button key={p.id} type="button" aria-pressed={product === p.id} className={pill(product === p.id && !search)} onClick={() => pick(`product:${p.id}`, p.id)}>
                {p.name} <span className="tabular-nums opacity-70">{p.count}</span>
              </button>
            ))}
        </div>
      ) : null}

      {inProduct ? (
        <div className="flex flex-wrap gap-1.5 text-xs" role="group" aria-label={`Stages in ${inProduct.name}`}>
          <button type="button" className={pill(show === `product:${inProduct.id}`)} onClick={() => pick(`product:${inProduct.id}`, inProduct.id)}>
            All in {inProduct.name}
          </button>
          {(["new", "onboarding", "stuck", "activated"] as const).map((s) => (
            <button key={s} type="button" className={pill(show === `stage:${inProduct.id}:${s}`)} onClick={() => pick(`stage:${inProduct.id}:${s}`, inProduct.id)}>
              {STAGE_LABEL[s]} <span className="tabular-nums opacity-70">{inProduct.stages[s]}</span>
            </button>
          ))}
          <button type="button" className={pill(show === `quiet:${inProduct.id}`)} onClick={() => pick(`quiet:${inProduct.id}`, inProduct.id)}>
            Quiet <span className="tabular-nums opacity-70">{inProduct.stages.quiet}</span>
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search everyone by name, email or domain"
          aria-label="Search people"
          className={`${inputClass} max-w-xs`}
        />
        <label className={`flex items-center gap-1.5 text-sm ${search ? "opacity-50" : ""}`}>
          <input type="checkbox" checked={canEmail} disabled={Boolean(search)} onChange={(e) => setCanEmail(e.target.checked)} />
          Only people we can email
          {filters ? <span className="tabular-nums text-neutral-500">({filters.canEmail} in all)</span> : null}
        </label>
      </div>

      {!rows ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          {search ? `Nobody matches “${search}”.` : "Nobody in this group yet."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="whitespace-nowrap text-left text-xs text-neutral-500">
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th className="px-3 py-2 font-medium">Person</th>
                <th className="px-3 py-2 font-medium">Where from</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Can email</th>
                <th className="px-3 py-2 font-medium">Last active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
              {rows.map((p) => {
                const href = personHref(p.id);
                return (
                  <tr key={p.id} onClick={() => router.push(href)} className="cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
                    <td className="px-3 py-2">
                      <Link href={href} onClick={(e) => e.stopPropagation()} className="block font-medium hover:underline">
                        {p.name ?? p.email ?? p.phone ?? "Unnamed person"}
                      </Link>
                      {p.name && (p.email ?? p.phone) ? <span className="text-xs text-neutral-500">{p.email ?? p.phone}</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex max-w-[18rem] flex-wrap gap-1">
                        {p.launches.map((l) => (
                          <Chip key={l.id} tone="neutral" title={`${LAUNCH_STATUS[l.status] ?? l.status}${l.via === "site" ? ", from your site" : ""}`}>
                            {l.name}
                          </Chip>
                        ))}
                        {p.products.map((x, i) => (
                          <Chip key={`${x.id}:${i}`} tone="blue">
                            {x.name}
                          </Chip>
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {p.products.map((x, i) => (
                          <span key={`${x.id}:${i}`} className="flex gap-1">
                            {x.stage === "member" ? null : (
                              <Chip tone={STAGE_TONE[x.stage]} title={multiProduct ? x.name : undefined}>
                                {STAGE_LABEL[x.stage]}
                              </Chip>
                            )}
                            {x.quiet ? <Chip tone="amber">Quiet</Chip> : null}
                          </span>
                        ))}
                        {p.products.length === 0
                          ? p.launches.slice(0, 1).map((l) => (
                              <Chip key={l.id} tone={l.status === "verified_active" ? "green" : "neutral"}>
                                {LAUNCH_STATUS[l.status] ?? l.status}
                              </Chip>
                            ))
                          : null}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {p.reach === "yes" ? (
                        <Chip tone="green">Yes</Chip>
                      ) : p.reach === "limited" ? (
                        <Chip tone="amber" title="Some emails only: service emails, the confirmation, or not every category">
                          Some
                        </Chip>
                      ) : (
                        <Chip tone="red" title={p.blocked ? BLOCKED[p.blocked] : undefined}>
                          {p.blocked ? BLOCKED[p.blocked] : "No"}
                        </Chip>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-neutral-500">
                      {p.activeAt ? <span title={day(p.activeAt)}>{ago(p.activeAt)}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows && rows.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
          <span>
            {rows.length} of {total ?? rows.length} {total === 1 ? "person" : "people"}
            {search ? ", searching everyone" : ""}
          </span>
          {cursor ? (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void more()}
              className="rounded-md border border-neutral-300 px-3 py-1 text-sm text-neutral-800 hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
