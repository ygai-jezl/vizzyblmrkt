"use client";

import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { FileText } from "lucide-react";
import { KIND_GROUPS, KIND_LABEL, MATCH_LABEL, groupOf } from "@/lib/search/labels";
import type { SearchKind } from "@/lib/search/types";

interface Hit {
  sourceKey: string;
  kind: SearchKind;
  title: string;
  url: string;
  snippet: string;
  matched: "words" | "meaning" | "both";
}

interface Answer {
  hits: Hit[];
  reranked: boolean;
  meaning: boolean;
}

type State = { status: "idle" } | { status: "loading" } | { status: "done"; answer: Answer } | { status: "message"; text: string };

const ITEM =
  "flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 text-sm text-shell-ink data-[selected=true]:bg-shell-active";
const BADGE = "shrink-0 rounded border border-shell-line px-1.5 py-px text-[10.5px] font-medium text-shell-muted";

/**
 * The Search panel's results inside ⌘K (NEXT_PUBLIC_SEARCH_ENABLED): what the brand wrote that
 * matches, by its words, its meaning or both. Asks the search API a moment after typing stops.
 */
export function BrandSearchResults({ query, onOpen }: { query: string; onOpen: (url: string) => void }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [group, setGroup] = useState<string>("all");
  const q = query.trim();

  useEffect(() => {
    setGroup("all");
    if (q.length < 2) {
      setState({ status: "idle" });
      return;
    }
    const ctl = new AbortController();
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      fetch(`/api/admin/search?q=${encodeURIComponent(q)}&limit=20`, { signal: ctl.signal })
        .then(async (res) => {
          if (res.ok) return setState({ status: "done", answer: (await res.json()) as Answer });
          if (res.status === 403) return setState({ status: "message", text: "Search isn't available for this brand yet." });
          setState({ status: "message", text: "Search didn't answer. Try again in a moment." });
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name !== "AbortError") setState({ status: "message", text: "Search didn't answer. Try again in a moment." });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q]);

  const hits = state.status === "done" ? state.answer.hits : [];
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of hits) m.set(groupOf(h.kind), (m.get(groupOf(h.kind)) ?? 0) + 1);
    return m;
  }, [hits]);
  const shown = group === "all" ? hits : hits.filter((h) => groupOf(h.kind) === group);

  if (state.status === "idle") return null;
  return (
    <Command.Group heading="Found in what you wrote">
      {state.status === "loading" ? (
        <Command.Item value={`search loading ${q}`} forceMount disabled className="px-3 py-2 text-sm text-shell-muted">
          Searching…
        </Command.Item>
      ) : null}
      {state.status === "message" ? (
        <Command.Item value={`search message ${q}`} forceMount disabled className="px-3 py-2 text-sm text-shell-muted">
          {state.text}
        </Command.Item>
      ) : null}
      {state.status === "done" && !hits.length ? (
        <Command.Item value={`search none ${q}`} forceMount disabled className="px-3 py-2 text-sm text-shell-muted">
          Nothing you wrote matches yet.
        </Command.Item>
      ) : null}
      {hits.length && counts.size > 1 ? (
        <div className="flex flex-wrap gap-1.5 px-3 pb-1.5 pt-0.5" role="group" aria-label="Show only">
          {[{ key: "all", label: "All", n: hits.length }, ...KIND_GROUPS.filter((g) => counts.has(g.key)).map((g) => ({ key: g.key, label: g.label, n: counts.get(g.key) ?? 0 }))].map((c) => (
            <button
              key={c.key}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setGroup(c.key)}
              aria-pressed={group === c.key}
              className={`rounded-full border px-2 py-0.5 text-xs ${group === c.key ? "border-shell-accent text-shell-ink" : "border-shell-line text-shell-muted"}`}
            >
              {c.label} {c.n}
            </button>
          ))}
        </div>
      ) : null}
      {shown.map((h, i) => (
        <Command.Item key={h.sourceKey} value={`search ${q} ${i} ${h.sourceKey}`} forceMount onSelect={() => onOpen(h.url)} className={ITEM}>
          <FileText size={16} aria-hidden className="mt-0.5 shrink-0 text-shell-muted" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className={BADGE}>{KIND_LABEL[h.kind] ?? h.kind}</span>
              <span className="truncate font-medium">{h.title}</span>
              <span className={`${BADGE} ml-auto`} title="Why it matched">
                {MATCH_LABEL[h.matched]}
              </span>
            </span>
            <span className="mt-0.5 line-clamp-2 block text-xs text-shell-muted">{h.snippet}</span>
          </span>
        </Command.Item>
      ))}
      {state.status === "done" && hits.length ? (
        <p className="px-3 pb-1 pt-1.5 text-[11px] text-shell-faint">
          {shown.length} shown. {state.answer.meaning ? "Words and meaning merged" : "Words only for now"}
          {state.answer.reranked ? ", then reranked." : "."}
        </p>
      ) : null}
    </Command.Group>
  );
}
