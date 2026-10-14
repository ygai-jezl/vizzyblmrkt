"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { BrandMapLink } from "@/lib/types/brandMap";
import type { LookupCandidate, LookupKind } from "@/lib/brandMap/lookup";
import { api, errorText } from "@/components/admin/connect/api";
import { Badge, Banner, Button, inputClass } from "@/components/admin/connect/ui";
import { linkLabel } from "./BrandMapIdentity";

/**
 * "Find" an identifier for one name: candidates from Wikidata, each with its description,
 * and "Use this" — or a link the admin pastes. Several things share a name, so nothing is
 * chosen for them; and nothing is kept until they save the map.
 */

const SOURCE_OF = (url: string): BrandMapLink["source"] =>
  /^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/.test(url) ? "wikidata" : /\.wikipedia\.org\/wiki\//.test(url) ? "wikipedia" : "manual";

export function BrandMapLookup({
  name,
  kind,
  canLookup,
  disabled,
  label = "Find",
  onUse,
}: {
  name: string;
  kind: LookupKind;
  canLookup: boolean;
  disabled: boolean;
  label?: string;
  onUse: (links: BrandMapLink[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<LookupCandidate[] | null>(null);
  const [pasted, setPasted] = useState("");

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  const start = async () => {
    setOpen(true);
    setError("");
    setCandidates(null);
    if (!canLookup) return;
    setLoading(true);
    const res = await api<{ candidates?: LookupCandidate[]; error?: string }>("/api/admin/brand-kit/map/lookup", {
      method: "POST",
      body: JSON.stringify({ name, kind }),
    });
    setLoading(false);
    if (!res.ok) setError(errorText(res.data));
    else setCandidates(res.data.candidates ?? []);
  };

  const use = (links: BrandMapLink[]) => {
    onUse(links);
    setOpen(false);
    setPasted("");
  };

  return (
    <>
      <Button className="px-2 py-0.5 text-xs" disabled={disabled || !name.trim()} onClick={start}>
        {label}
      </Button>
      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="brand-map-lookup-title"
            className="w-full max-w-lg space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="brand-map-lookup-title" className="text-base font-semibold">
                  Find an identifier
                </h2>
                <p className="text-sm text-neutral-500">For “{name}”.</p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="grid h-7 w-7 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <X size={16} aria-hidden />
              </button>
            </div>

            {canLookup ? (
              <>
                <p className="text-sm">Several things can share a name. Pick the one that is this.</p>
                {loading ? <p className="text-sm text-neutral-500">Looking on Wikidata…</p> : null}
                {error ? <Banner tone="err">{error}</Banner> : null}
                {candidates && !candidates.length ? <p className="text-sm text-neutral-500">Wikidata has nothing by that name.</p> : null}
                <ul className="space-y-2">
                  {(candidates ?? []).map((c) => (
                    <li key={c.id} className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold">{c.label}</span>
                          {c.looksLikeYou ? <Badge tone="green">This looks like you</Badge> : c.matched ? <Badge tone="green">Name matches</Badge> : null}
                        </div>
                        <p className="text-sm text-neutral-600 dark:text-neutral-300">{c.description || "No description on Wikidata"}</p>
                        <p className="flex flex-wrap gap-x-3 text-xs text-neutral-500">
                          <a href={c.wikidataUrl} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-2">
                            {c.id}
                          </a>
                          {c.officialSites[0] ? <span>Official site: {linkLabel(c.officialSites[0])}</span> : null}
                          {c.wikipediaUrl ? <span>Has a Wikipedia page</span> : null}
                        </p>
                      </div>
                      <Button
                        tone={c.looksLikeYou || c.matched ? "primary" : "secondary"}
                        onClick={() =>
                          use([
                            { url: c.wikidataUrl, source: "wikidata", confirmedAt: "" },
                            ...(c.wikipediaUrl ? [{ url: c.wikipediaUrl, source: "wikipedia" as const, confirmedAt: "" }] : []),
                          ])
                        }
                      >
                        Use this
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <div className="space-y-1 border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{canLookup ? "Or paste a link you trust" : "Paste a link you trust"}</span>
                <span className="flex gap-2">
                  <input className={inputClass} placeholder="https://" value={pasted} onChange={(e) => setPasted(e.target.value.trim())} />
                  <Button disabled={!/^https:\/\/\S+$/i.test(pasted)} onClick={() => use([{ url: pasted, source: SOURCE_OF(pasted), confirmedAt: "" }])}>
                    Add
                  </Button>
                </span>
              </label>
            </div>
            {canLookup ? <p className="text-xs text-neutral-500">Only the name is sent to Wikidata. Nothing is kept until you pick one and save the map.</p> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
