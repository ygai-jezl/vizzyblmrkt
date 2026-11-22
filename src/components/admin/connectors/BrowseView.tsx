"use client";

import { useState } from "react";
import Link from "next/link";
import type { ConnectionView, ConnectorListing } from "@/lib/connectors/service";
import {
  CARD,
  HINT,
  METHOD_LABELS,
  NOTE_PLAIN,
  SCREEN_COPY,
  TAG,
  TONE_CLASS,
  categoriesOf,
  categoryLabel,
  connectorStatus,
  filterConnectors,
  initialsOf,
  listingPath,
  tileClass,
} from "./words";

export interface BrowseProps {
  connectors: ConnectorListing[];
  connections: ConnectionView[];
  /** Vizzy reads connected data (CONNECTORS_CHAT_ENABLED). */
  chat: boolean;
}

/** A connector's tile: its initials on its own colour. */
export function ConnectorTile({ id, name, size = "md" }: { id: string; name: string; size?: "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center font-bold ${size === "lg" ? "h-12 w-12 rounded-xl text-base" : "h-10 w-10 rounded-lg text-sm"} ${tileClass(id)}`}
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * Settings › Connections › Browse: the connectors this copy offers now (each one's own switch on
 * and a way to connect ready), with a search box and a chip per category. Each card opens the
 * connector's Listing. Members see the same cards; only admins connect, on the Listing.
 */
export function BrowseView({ connectors, connections, chat }: BrowseProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const categories = categoriesOf(connectors);
  const shown = filterConnectors(connectors, query, category);
  const chip = (on: boolean) =>
    `inline-flex h-8 items-center rounded-full border px-3 text-sm ${
      on
        ? "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100"
        : "border-neutral-300 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
    }`;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-neutral-500 dark:text-neutral-400">{chat ? SCREEN_COPY.browseLeadVizzy : SCREEN_COPY.browseLead}</p>
      {connectors.length === 0 ? (
        <p className={NOTE_PLAIN}>{SCREEN_COPY.noConnectors}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="connector-search" className="sr-only">
              Search connectors
            </label>
            <input
              id="connector-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search connectors"
              className="h-9 w-72 max-w-full rounded-md border border-neutral-300 bg-transparent px-3 text-sm dark:border-neutral-700"
            />
            {categories.length > 1 ? (
              <>
                <button type="button" className={chip(category === null)} aria-pressed={category === null} onClick={() => setCategory(null)}>
                  All
                </button>
                {categories.map((c) => (
                  <button key={c} type="button" className={chip(category === c)} aria-pressed={category === c} onClick={() => setCategory(c)}>
                    {categoryLabel(c)}
                  </button>
                ))}
              </>
            ) : null}
          </div>
          {shown.length === 0 ? (
            <p className={NOTE_PLAIN}>{SCREEN_COPY.noMatch}</p>
          ) : (
            <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
              {shown.map((c) => {
                const status = connectorStatus(c.id, connections);
                return (
                  <li key={c.id}>
                    <Link href={listingPath(c.id)} className={`${CARD} flex h-full flex-col gap-3 hover:border-neutral-400 dark:hover:border-neutral-600`}>
                      <span className="flex items-center gap-3">
                        <ConnectorTile id={c.id} name={c.name} />
                        <span className="flex flex-col">
                          <span className="text-sm font-semibold">{c.name}</span>
                          <span className={HINT}>{categoryLabel(c.category)} · Built by YouGrow</span>
                        </span>
                      </span>
                      <span className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">{c.summary}</span>
                      <span className="mt-auto flex flex-wrap gap-1.5">
                        <span className={`${TAG} ${TONE_CLASS[status.tone]}`}>{status.label}</span>
                        {c.ready.map((m) => (
                          <span key={m} className={`${TAG} ${TONE_CLASS.plain}`}>
                            {METHOD_LABELS[m]}
                          </span>
                        ))}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <p className={HINT}>{SCREEN_COPY.browseFoot}</p>
    </div>
  );
}
