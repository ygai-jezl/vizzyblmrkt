"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, errorText } from "@/components/admin/connect/api";
import { Badge, Banner, Button, inputClass } from "@/components/admin/connect/ui";
import { BRAND_KIT_COMPETITORS_ROUTE } from "@/lib/content/brandKit";
import { COMPETITOR_LIMITS } from "@/lib/types/competitor";
import { STATUS_LABEL, type CompetitorDetail, type CompetitorSummary } from "@/lib/competitors/view";
import type { FinderState, Suggestion } from "@/lib/brandStrategy/adminApi";
import { COMPETITOR_GROUP_LABEL, type CompetitorGroupKind } from "@/lib/types/brandStrategy";
import { CompetitorGroupPicker } from "./CompetitorGroupPicker";
import { finderNote, foundNote, notCompetitorNote, strategyErrorText, watchingNote } from "./strategyMessages";

/**
 * Brand › Competitors: Monitor a competitor's website, and the competitors already watched, each
 * with what changed since anyone last looked. While a new one is set up, the page carries the work
 * on (admins) a step at a time, so its progress shows as it happens.
 *
 * Joined to the strategy (`door`, STRATEGY_COMPETITORS_ENABLED), it is the second door to the
 * Strategy tab's list: Find competitors, the finder's suggestions with Monitor and Not a
 * competitor, and a group on each card.
 */

const FINDER = "/api/admin/brand-kit/map/strategy/competitors";
const LIST = "/api/admin/brand-kit/competitors";
const SMALL = "rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

const SETTING_UP = new Set(["finding", "reading", "analysing"]);

/** "acme-dental.example" → "Acme Dental": a starting point for the name, which the person can change. */
export function nameFromWebsite(raw: string): string {
  const host = raw
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .split(/[/?#]/)[0]!
    .replace(/^www\./i, "")
    .toLowerCase();
  const label = host.split(".")[0] ?? "";
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, COMPETITOR_LIMITS.MAX_NAME);
}

export function shortDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function statusTone(c: CompetitorSummary): "neutral" | "green" | "amber" | "red" {
  if (c.status === "watching") return c.problem ? "amber" : "green";
  if (c.status === "needs_you") return "red";
  return c.status === "paused" ? "neutral" : "amber";
}

function statusText(c: CompetitorSummary): string {
  if (c.status === "reading" && c.progress && c.progress.total > 0) return `Reading their site, ${c.progress.done} of ${c.progress.total}`;
  return STATUS_LABEL[c.status];
}

/** One line of numbers: pages, sections, how often they post. */
export function statsLine(c: CompetitorSummary): string {
  const parts: string[] = [];
  if (c.readThroughGoogle) parts.push("news only, read through Google");
  if (c.pages != null) parts.push(`${c.truncated ? "first " : ""}${c.pages.toLocaleString()} page${c.pages === 1 ? "" : "s"}`);
  if (c.sections) parts.push(`${c.sections} section${c.sections === 1 ? "" : "s"}`);
  if (c.newsPerMonth != null) parts.push(c.newsPerMonth >= 1 ? `about ${Math.round(c.newsPerMonth)} posts a month` : "fewer than 1 post a month");
  return parts.join(" · ");
}

export const BRAND_MAP_NOTE: Record<"added" | "already" | "suggested" | "not_added", (name: string) => string> = {
  added: (n) => `Added ${n} to your brand map's alternatives.`,
  already: (n) => `${n} is on your brand map already.`,
  suggested: (n) => `${n} waits under Suggestions on your brand map, because you haven't saved the map yet.`,
  not_added: (n) => `We couldn't add ${n} to your brand map. You can add it from its page.`,
};

export function CompetitorsPage({
  initial,
  canEdit,
  prefillName,
  door = null,
}: {
  initial: CompetitorSummary[];
  canEdit: boolean;
  prefillName: string;
  door?: { suggestions: Suggestion[]; finder: FinderState; was: Record<string, CompetitorGroupKind> } | null;
}) {
  const [list, setList] = useState(initial);
  const [suggestions, setSuggestions] = useState(door?.suggestions ?? []);
  const [finder, setFinder] = useState(door?.finder ?? null);
  const [was, setWas] = useState(door?.was ?? {});
  const [doorNote, setDoorNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [website, setWebsite] = useState("");
  const [name, setName] = useState(prefillName);
  const [nameTouched, setNameTouched] = useState(Boolean(prefillName));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const advancing = useRef(false);

  // Carry setup on while a competitor is still being set up: admins drive it, members watch.
  const settingUp = list.find((c) => SETTING_UP.has(c.status));
  useEffect(() => {
    if (!settingUp || advancing.current) return;
    let cancelled = false;
    const timer = setTimeout(
      async () => {
        advancing.current = true;
        const r = canEdit
          ? await api<{ competitor?: CompetitorDetail }>(`/api/admin/brand-kit/competitors/${settingUp.id}`, {
              method: "POST",
              body: JSON.stringify({ action: "advance" }),
            })
          : await api<{ competitors?: CompetitorSummary[] }>("/api/admin/brand-kit/competitors");
        advancing.current = false;
        if (cancelled || !r.ok) return;
        const data = r.data as { competitor?: CompetitorDetail; competitors?: CompetitorSummary[] };
        if (data.competitors) setList(data.competitors);
        else if (data.competitor) setList((all) => all.map((c) => (c.id === data.competitor!.id ? data.competitor! : c)));
      },
      canEdit ? 800 : 10_000,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [settingUp, canEdit]);

  async function monitor() {
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await api<{ competitor?: CompetitorDetail; brandMap?: keyof typeof BRAND_MAP_NOTE | null; id?: string }>("/api/admin/brand-kit/competitors", {
      method: "POST",
      body: JSON.stringify({ website, name: name.trim() || nameFromWebsite(website) }),
    });
    setBusy(false);
    if (!r.ok || !r.data.competitor) return setError(errorText(r.data));
    const added = r.data.competitor;
    setList((all) => [...all, added]);
    setWebsite("");
    setName("");
    setNameTouched(false);
    if (r.data.brandMap) setNote(BRAND_MAP_NOTE[r.data.brandMap](added.name));
  }

  const full = list.length >= COMPETITOR_LIMITS.MAX_PER_BRAND;

  /** The list and the finder's suggestions as they are now. */
  async function refresh() {
    const r = await api<{ competitors?: CompetitorSummary[]; suggestions?: Suggestion[]; was?: Record<string, CompetitorGroupKind> }>(LIST);
    if (!r.ok) return;
    if (r.data.competitors) setList(r.data.competitors);
    if (r.data.suggestions) setSuggestions(r.data.suggestions);
    if (r.data.was) setWas(r.data.was);
  }

  async function doorRun(path: string, body: unknown, done: (data: Record<string, unknown>) => string) {
    setBusy(true);
    setDoorNote(null);
    const r = await api<Record<string, unknown> & { strategy?: { finder?: FinderState } }>(path, { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok && r.data.error !== "already_watching") return setDoorNote({ tone: "err", text: strategyErrorText(r.data) });
    if (r.data.strategy?.finder) setFinder(r.data.strategy.finder);
    await refresh();
    setDoorNote({ tone: "ok", text: done(r.data) });
  }

  const find = (mode: "quick" | "full") => doorRun(FINDER, { mode }, (d) => foundNote(Number(d.found ?? 0), Boolean(d.gapSkipped), true));
  const watch = (c: Suggestion) => doorRun(LIST, { name: c.name, website: c.site, ...(c.group ? { group: c.group } : {}) }, () => watchingNote(c.name));
  const notOne = (c: Suggestion) => doorRun(`${FINDER}/not`, { name: c.name, site: c.site }, () => notCompetitorNote(c.name));

  return (
    <div className="space-y-5">
      {canEdit ? (
        <form
          className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
          onSubmit={(e) => {
            e.preventDefault();
            void monitor();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[2fr_1.4fr_auto] sm:items-end">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Their website</span>
              <input
                className={inputClass}
                value={website}
                placeholder="acme-dental.example"
                inputMode="url"
                autoComplete="off"
                disabled={busy || full}
                onChange={(e) => {
                  setWebsite(e.target.value);
                  if (!nameTouched) setName(nameFromWebsite(e.target.value));
                }}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Name</span>
              <input
                className={inputClass}
                value={name}
                maxLength={COMPETITOR_LIMITS.MAX_NAME}
                disabled={busy || full}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
              />
            </label>
            <Button tone="primary" type="submit" disabled={busy || full || !website.trim()}>
              {busy ? "Starting…" : "Monitor"}
            </Button>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {full
              ? `You're watching ${COMPETITOR_LIMITS.MAX_PER_BRAND} competitors, the most you can. Stop watching one to add another.`
              : "We read their sitemap, learn how their site is built, then check their news page every week and the whole site every month. The name goes on your brand map's alternatives."}
          </p>
          {error ? <Banner tone="err">{error}</Banner> : null}
          {note ? <Banner tone="ok">{note}</Banner> : null}
        </form>
      ) : null}

      {door && (finder?.on || suggestions.length) ? (
        <section aria-label="Find competitors" className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Suggested by the finder</h2>
            {canEdit && finder?.on ? (
              <span className="flex flex-wrap gap-2">
                <Button disabled={busy || (!finder.granted && finder.quickUsed)} onClick={() => void find("quick")}>
                  Find competitors
                </Button>
                {finder.granted ? (
                  <Button disabled={busy} onClick={() => void find("full")}>
                    Full search
                  </Button>
                ) : null}
              </span>
            ) : null}
          </div>
          {finder?.on ? <p className="text-xs text-neutral-500 dark:text-neutral-400">It asks Google who buyers weigh instead of you. {finderNote(finder)}</p> : null}
          {suggestions.length ? (
            <ul className="space-y-1.5 text-sm">
              {suggestions.map((c) => (
                <li key={c.name} className="flex flex-wrap items-center gap-1.5" title={c.evidence.map((e) => e.title || e.domain).join(" · ") || undefined}>
                  <span className="font-medium">{c.name}</span>
                  {c.site ? <span className="text-neutral-500">{c.site}</span> : null}
                  {c.group ? <span className="text-xs text-neutral-500">· {COMPETITOR_GROUP_LABEL[c.group]}</span> : null}
                  {canEdit && c.site ? (
                    <button type="button" className={SMALL} disabled={busy || full} onClick={() => void watch(c)}>
                      Monitor
                    </button>
                  ) : null}
                  {canEdit ? (
                    <button type="button" className={SMALL} disabled={busy} onClick={() => void notOne(c)}>
                      Not a competitor
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">No suggestions waiting. What the finder finds shows here and on the Strategy tab.</p>
          )}
          {doorNote ? <Banner tone={doorNote.tone}>{doorNote.text}</Banner> : null}
        </section>
      ) : door && doorNote ? (
        <Banner tone={doorNote.tone}>{doorNote.text}</Banner>
      ) : null}

      {list.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No competitors yet.{" "}
          {canEdit ? "Type a competitor's website above and press Monitor." : "An admin can add one."}
        </p>
      ) : (
        <ul className="space-y-3">
          {list.map((c) => (
            <li key={c.id} className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {c.name} <span className="font-normal text-neutral-500">{c.site}</span>
                  </p>
                  {statsLine(c) ? <p className="text-sm text-neutral-600 dark:text-neutral-300">{statsLine(c)}</p> : null}
                </div>
                <Badge tone={statusTone(c)}>{statusText(c)}</Badge>
              </div>
              {c.latest ? (
                <p className="mt-2 text-sm">
                  <span className="mr-1.5 inline-block size-2 rounded-full bg-blue-500" aria-hidden />
                  {c.latest.headline}
                  {c.unseen > 1 ? <span className="text-neutral-500"> and {c.unseen - 1} more</span> : null}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                <span className="flex flex-wrap items-center gap-2">
                  {door ? (
                    <CompetitorGroupPicker
                      id={c.id}
                      name={c.name}
                      group={c.group}
                      was={was[c.id] ?? null}
                      canEdit={canEdit}
                      onSaved={(group) => setList((all) => all.map((x) => (x.id === c.id ? { ...x, group } : x)))}
                      onError={(text) => setDoorNote({ tone: "err", text })}
                    />
                  ) : null}
                  <span>
                    {c.nextCheckAt ? `Next check ${shortDate(c.nextCheckAt)}` : c.status === "needs_you" ? "Waiting for you" : ""}
                    {!c.onBrandMap ? " · Not on your brand map" : ""}
                  </span>
                </span>
                <Link href={`${BRAND_KIT_COMPETITORS_ROUTE}/${c.id}`} className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900">
                  Open
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
