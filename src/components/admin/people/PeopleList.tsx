"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { personHref } from "@/lib/audience/paths";
import type { AudiencePerson } from "@/lib/audience/people";
import type { PersonSummary } from "@/lib/audience/personRecord";
import { reachText, stageChips, type PersonReach } from "@/lib/audience/personStage";
import { api } from "../connect/api";
import { inputClass } from "../connect/ui";
import { ago, day } from "./format";
import { Chip } from "./Chip";

/**
 * Audience → Product users with the person view on: everyone using your connected
 * products, the stage each is at, the journey they're in and what they've done
 * with your emails. Search and the stage filters work on the list as loaded; a
 * row's journey and emails load once it's on screen. Every row opens the person.
 */

type Filter = "all" | "new" | "onboarding" | "stuck" | "activated" | "quiet" | "cant";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "new", label: "New" },
  { id: "onboarding", label: "Onboarding" },
  { id: "stuck", label: "Stuck" },
  { id: "activated", label: "Activated" },
  { id: "quiet", label: "Quiet" },
  { id: "cant", label: "Can't email" },
];

const PAGE = 50;
const SUMMARY_CHUNK = 60;

/** How far a row has got with its summary: not asked yet (absent), loading, or here (null = it couldn't load). */
type Loaded = Record<string, PersonSummary | "loading" | null>;

function matches(p: AudiencePerson, filter: Filter, reach: PersonReach): boolean {
  switch (filter) {
    case "all":
      return true;
    case "quiet":
      return p.stage.quietDays !== null;
    case "cant":
      return reach.can === "no";
    case "onboarding":
      // Someone stuck is still onboarding.
      return p.stage.kind === "onboarding" || p.stage.kind === "stuck";
    default:
      return p.stage.kind === filter;
  }
}

export function PeopleList() {
  const router = useRouter();
  const [people, setPeople] = useState<AudiencePerson[] | null>(null);
  const [truncated, setTruncated] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const [summaries, setSummaries] = useState<Loaded>({});
  const asked = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;
    api<{ people: AudiencePerson[]; truncated: boolean; window: number }>("/api/admin/audience/people").then((r) => {
      if (!alive) return;
      if (!r.ok) return setError(true);
      setPeople(r.data.people);
      setTruncated(r.data.truncated ? r.data.window : null);
    });
    return () => {
      alive = false;
    };
  }, []);

  // An opt-out made in one of our emails only arrives with the row's summary.
  const reachOf = (p: AudiencePerson): PersonReach => {
    const s = summaries[p.id];
    return s && s !== "loading" ? s.reach : p.reach;
  };

  const needle = q.trim().toLowerCase();
  const found = useMemo(
    () =>
      (people ?? []).filter(
        (p) => !needle || p.name?.toLowerCase().includes(needle) || p.email?.toLowerCase().includes(needle) || p.product.toLowerCase().includes(needle),
      ),
    [people, needle],
  );
  const filtered = found.filter((p) => matches(p, filter, reachOf(p)));
  const visible = filtered.slice(0, shown);
  const visibleIds = visible.map((p) => p.id).join(",");

  useEffect(() => {
    const ids = visibleIds.split(",").filter((id) => id && !asked.current.has(id));
    if (ids.length === 0) return;
    for (const id of ids) asked.current.add(id);
    setSummaries((cur) => ({ ...cur, ...Object.fromEntries(ids.map((id) => [id, "loading" as const])) }));
    for (let i = 0; i < ids.length; i += SUMMARY_CHUNK) {
      const chunk = ids.slice(i, i + SUMMARY_CHUNK);
      void api<{ summaries: PersonSummary[] }>("/api/admin/audience/people/summaries", { method: "POST", body: JSON.stringify({ ids: chunk }) }).then((r) => {
        const got = new Map((r.ok ? r.data.summaries : []).map((s) => [s.id, s]));
        setSummaries((cur) => ({ ...cur, ...Object.fromEntries(chunk.map((id) => [id, got.get(id) ?? null])) }));
      });
    }
  }, [visibleIds]);

  if (error) return <p className="text-sm text-red-700 dark:text-red-400">Couldn&rsquo;t load product users — please try again.</p>;
  if (!people) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (!people.length) {
    return (
      <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
        No product users yet. They appear when a{" "}
        <Link href="/admin/products" className="underline underline-offset-2">
          connected product
        </Link>{" "}
        sends its first sign-up.
      </p>
    );
  }

  const count = (f: Filter) => found.filter((p) => matches(p, f, reachOf(p))).length;
  // One product is the usual case: its name on every row says nothing, and the room is better spent.
  const products = [...new Set(people.map((p) => p.product))];
  const showProduct = products.length > 1;
  const pick = (f: Filter) => {
    setFilter(f);
    setShown(PAGE);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShown(PAGE);
          }}
          placeholder="Search name, email or product…"
          aria-label="Search product users"
          className={`${inputClass} max-w-xs`}
        />
        <div className="flex flex-wrap gap-1.5 text-xs" role="group" aria-label="Filter by stage">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => pick(f.id)}
              className={`rounded-md border px-2.5 py-1 ${
                filter === f.id
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              }`}
            >
              {f.label} <span className="tabular-nums opacity-70">{count(f.id)}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Nobody matches{needle ? ` “${q.trim()}”` : ""}
          {filter !== "all" ? ` in ${FILTERS.find((f) => f.id === filter)!.label}` : ""}.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="whitespace-nowrap text-left text-xs text-neutral-500">
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th className="px-3 py-2 font-medium">Person</th>
                {showProduct ? <th className="px-3 py-2 font-medium">Product</th> : null}
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Journey now</th>
                <th className="px-3 py-2 font-medium" title="Emails sent, then how many of them were opened and clicked">
                  Emails <span className="block font-normal">sent · opened · clicked</span>
                </th>
                <th className="px-3 py-2 font-medium">Last active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
              {visible.map((p) => {
                const s = summaries[p.id];
                const summary = s && s !== "loading" ? s : null;
                const reach = reachText(reachOf(p));
                const href = personHref(p.id);
                return (
                  <tr key={p.id} onClick={() => router.push(href)} className="cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
                    <td className="px-3 py-2">
                      <Link href={href} onClick={(e) => e.stopPropagation()} className="block font-medium hover:underline">
                        {p.name ?? p.email ?? "Unnamed user"}
                      </Link>
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                        {p.name && p.email ? p.email : null}
                        {p.onWaitlist ? <Chip tone="blue">On your waitlist</Chip> : null}
                        {p.invited ? <Chip tone="green">Invited</Chip> : null}
                      </span>
                    </td>
                    {showProduct ? <td className="whitespace-nowrap px-3 py-2 text-neutral-600 dark:text-neutral-400">{p.product}</td> : null}
                    <td className="px-3 py-2">
                      <span
                        className="flex min-w-[11rem] flex-wrap gap-1"
                        title={p.onboarding.steps.length ? p.onboarding.steps.map((x) => `${x.done ? "✓" : "☐"} ${x.label}`).join("\n") : undefined}
                      >
                        {stageChips(p.stage).map((c) => (
                          <Chip key={c.text} tone={c.tone}>
                            {c.text}
                          </Chip>
                        ))}
                        {reach.tone === "green" ? null : (
                          <Chip tone={reach.tone} title={reach.why ?? undefined}>
                            {reach.chip}
                          </Chip>
                        )}
                        {stageChips(p.stage).length === 0 && reach.tone === "green" ? <span className="text-neutral-400">—</span> : null}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <JourneyCell summary={s} />
                    </td>
                    <td className="px-3 py-2">
                      <EmailsCell summary={s} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-neutral-500">
                      {p.lastActiveAt ? (
                        <span title={day(p.lastActiveAt)}>{ago(p.lastActiveAt)}</span>
                      ) : (
                        <span className="text-xs" title="Your product doesn't say when people were last active. This is the last time it sent us anything about them.">
                          updated {ago(p.lastSyncAt)}
                        </span>
                      )}
                      {summary && summary.activeJourneys > 1 ? <span className="block text-xs">{summary.activeJourneys} journeys</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
        <span>
          Showing {visible.length} of {filtered.length}
          {showProduct ? "" : ` on ${products[0]}`}
          {truncated ? `. This list reads each product's ${truncated} most recently updated people; a product's Users tab lists everyone.` : ""}
        </span>
        {filtered.length > visible.length ? (
          <button
            type="button"
            onClick={() => setShown((n) => n + PAGE)}
            className="rounded-md border border-neutral-300 px-3 py-1 text-sm text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
          >
            Show {Math.min(PAGE, filtered.length - visible.length)} more
          </button>
        ) : null}
      </div>
    </div>
  );
}

function JourneyCell({ summary }: { summary: PersonSummary | "loading" | null | undefined }) {
  if (summary === undefined || summary === "loading") return <span className="text-neutral-400">…</span>;
  const j = summary?.journey;
  if (!j) return <span className="text-neutral-400">—</span>;
  const sub =
    j.status === "active"
      ? (j.note ?? (j.next ? `Next ${day(j.next.at)} · ${j.next.label}` : `${j.sent} sent`))
      : j.status === "completed"
        ? "Finished"
        : (j.note ?? "Stopped");
  return (
    <span className="block max-w-[16rem]">
      <span className="block truncate">{j.name}</span>
      <span className="block truncate text-xs text-neutral-500" title={sub}>
        {sub}
      </span>
    </span>
  );
}

function EmailsCell({ summary }: { summary: PersonSummary | "loading" | null | undefined }) {
  if (summary === undefined || summary === "loading") return <span className="text-neutral-400">…</span>;
  if (!summary || summary.emails.sent === 0) return <span className="text-neutral-400">—</span>;
  const { sent, opened, clicked, tracked } = summary.emails;
  if (tracked === 0) {
    return (
      <span className="whitespace-nowrap tabular-nums" title="Opens and clicks weren't tracked for these emails">
        {sent} · <span className="text-neutral-400">–</span> · <span className="text-neutral-400">–</span>
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap tabular-nums" title={tracked < sent ? `${tracked} of these ${sent} emails were tracked` : undefined}>
      {sent} · {opened} · {clicked}
    </span>
  );
}
